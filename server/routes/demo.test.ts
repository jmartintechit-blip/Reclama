import { readFileSync } from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SESSION_COOKIE } from '../auth/session.ts';
import type { EmailConfig } from '../config.ts';
import { createFakeMailer, type FakeMailer } from '../services/fake-mailer.ts';
import {
  dataOf,
  errorOf,
  startTestApp,
  type DebtorJson,
  type InvoiceJson,
  type TestApp,
  type TestUser,
} from './test-app.ts';

const NOW = '2026-10-30T10:00:00Z'; // 2026-10-30 in Madrid
const HOUR = 60 * 60 * 1000;
// Live mode on purpose: a demo visitor must still be kept in the sandbox.
const LIVE_CONFIG: EmailConfig = {
  from: 'Reclama <sender@example.test>',
  mode: 'live',
  testRecipient: 'inbox@example.test',
};
const SAMPLE_CSV = readFileSync(
  new URL('../../data/sample-invoices.csv', import.meta.url),
);

let t: TestApp;
let mailer: FakeMailer;
beforeAll(async () => {
  mailer = createFakeMailer();
  t = await startTestApp({ now: NOW, mailer, emailConfig: LIVE_CONFIG });
}, 30_000);
// Every test opens a few sandboxes from the same address: the per-IP limit has its own tests.
beforeEach(async () => {
  await t.db.query('delete from rate_limits');
});
afterEach(() => {
  t.setNow(NOW);
});
afterAll(async () => {
  await t.stop();
});

// The visitor's side: no cookie, POST, then the cookie the answer sets.
async function openDemo() {
  const res = await t.call(null, 'POST', '/api/demo/session');
  const setCookie = res.headers.getSetCookie();
  const user: TestUser = {
    id: (dataOf(res).user as { id: string }).id,
    cookie: (setCookie[0] ?? '').split(';')[0] ?? '',
  };
  return { res, setCookie, user };
}

const debtorsOf = async (user: TestUser) =>
  (
    (await t.call(user, 'GET', '/api/debtors')).json as {
      data: { debtors: DebtorJson[] };
    }
  ).data.debtors;
const invoicesOf = async (user: TestUser) =>
  (
    (await t.call(user, 'GET', '/api/invoices?limit=100')).json as {
      data: { invoices: InvoiceJson[] };
    }
  ).data.invoices;

describe('POST /api/demo/session', () => {
  it('opens a sandbox: 201, a 2 hour session cookie and a user that lasts 24 hours', async () => {
    const { res, setCookie, user } = await openDemo();

    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({
      data: {
        user: { id: user.id, is_demo: true },
        expires_at: new Date(Date.parse(NOW) + 24 * HOUR).toISOString(),
        session_expires_at: new Date(Date.parse(NOW) + 2 * HOUR).toISOString(),
      },
    });
    expect(setCookie).toHaveLength(1);
    const [pair, ...attributes] = (setCookie[0] ?? '').split('; ');
    expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']),
    );
    expect(attributes).toContain('Max-Age=7200');
    expect(setCookie[0]).not.toMatch(/domain/i);
  });

  it('stores a user without email or password and a session that ends after 2 hours', async () => {
    const { user } = await openDemo();

    const stored = await t.db.query(
      `select u.is_demo, u.email, u.password_hash, u.expires_at, s.expires_at as session_expires_at
         from users u join sessions s on s.user_id = u.id where u.id = $1`,
      [user.id],
    );
    expect(stored.rows).toEqual([
      {
        is_demo: true,
        email: null,
        password_hash: null,
        expires_at: new Date(Date.parse(NOW) + 24 * HOUR),
        session_expires_at: new Date(Date.parse(NOW) + 2 * HOUR),
      },
    ]);
  });

  it('seeds the profile, 6 debtors of every kind and 14 invoices that show real interest', async () => {
    const { user } = await openDemo();

    const me = await t.call(user, 'GET', '/api/me');
    expect(dataOf(me)).toMatchObject({
      user: { id: user.id, email: null, is_demo: true },
      profile: {
        business_name: 'Estudio Ficticio Norte S.L.',
        iban: 'ES9121000418450200051332',
        default_compensation: 'PER_CLAIM',
      },
    });
    const debtors = await debtorsOf(user);
    expect(debtors.map((d) => d.kind).sort()).toEqual([
      'BUSINESS',
      'BUSINESS',
      'BUSINESS',
      'CONSUMER',
      'PUBLIC_ADMIN',
      'UNKNOWN',
    ]);
    for (const debtor of debtors)
      expect(debtor.email).toMatch(/@example\.(com|org)$/);

    const invoices = await invoicesOf(user);
    expect(invoices).toHaveLength(14);
    expect(invoices.filter((i) => i.overdue)).toHaveLength(11);
    expect(invoices.filter((i) => i.status !== 'OPEN')).toEqual([]);
    expect(invoices.filter((i) => i.paid_cents > 0)).toHaveLength(1);
    expect(invoices.map((i) => i.interest_error)).toEqual(Array(14).fill(null));
  });

  it('gives every visitor a separate sandbox', async () => {
    const first = await openDemo();
    const second = await openDemo();

    expect(first.user.id).not.toBe(second.user.id);
    expect(first.user.cookie).not.toBe(second.user.cookie);
    const ids = (await invoicesOf(first.user)).map((i) => i.id);
    const others = (await invoicesOf(second.user)).map((i) => i.id);
    expect(ids).toHaveLength(14);
    expect(others.filter((id) => ids.includes(id))).toEqual([]);
  });

  it('keeps a sandbox and a regular user out of each other’s data', async () => {
    const { user: demo } = await openDemo();
    const regular = await t.makeUser();
    const [demoInvoice] = await invoicesOf(demo);
    const [demoDebtor] = await debtorsOf(demo);
    if (!demoInvoice || !demoDebtor) throw new Error('the demo has no data');

    // The regular user sees nothing of the demo, and the demo sees nothing of the regular user.
    expect(await debtorsOf(regular)).toEqual([]);
    expect(await invoicesOf(regular)).toEqual([]);
    for (const [method, path, body] of [
      ['GET', `/api/invoices/${demoInvoice.id}`],
      ['PATCH', `/api/invoices/${demoInvoice.id}`, { number: 'HACKED' }],
      ['DELETE', `/api/invoices/${demoInvoice.id}`],
      ['GET', `/api/debtors/${demoDebtor.id}`],
      ['PATCH', `/api/debtors/${demoDebtor.id}`, { kind: 'CONSUMER' }],
    ] as const) {
      const res = await t.call(regular, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const own = await t.call(regular, 'POST', '/api/invoices', {
      debtor: { name: 'Only Regular S.L.' },
      number: 'R-1',
      issue_date: '2026-08-31',
      amount_cents: 1_000,
    });
    expect(own.status, own.text).toBe(201);
    expect((await debtorsOf(demo)).map((d) => d.name)).not.toContain(
      'Only Regular S.L.',
    );
    const intact = await t.call(demo, 'GET', `/api/invoices/${demoInvoice.id}`);
    expect(intact.status).toBe(200);
  });
});

describe('how long a demo lasts', () => {
  it('the session ends 2 hours after it was opened (checked on the injected clock)', async () => {
    const { user } = await openDemo();

    t.setNow(new Date(Date.parse(NOW) + 2 * HOUR - 1000).toISOString());
    expect((await t.call(user, 'GET', '/api/me')).status).toBe(200);
    t.setNow(new Date(Date.parse(NOW) + 2 * HOUR).toISOString());
    const expired = await t.call(user, 'GET', '/api/me');

    expect(expired.status).toBe(401);
    expect(errorOf(expired).code).toBe('UNAUTHENTICATED');
  });

  it('the user ends 24 hours after it was created, even if a session were still alive', async () => {
    const { user } = await openDemo();
    await t.db.query('update sessions set expires_at = $2 where user_id = $1', [
      user.id,
      new Date(Date.parse(NOW) + 7 * 24 * HOUR).toISOString(),
    ]);

    t.setNow(new Date(Date.parse(NOW) + 24 * HOUR - 1000).toISOString());
    expect((await t.call(user, 'GET', '/api/me')).status).toBe(200);
    t.setNow(new Date(Date.parse(NOW) + 24 * HOUR).toISOString());
    const expired = await t.call(user, 'GET', '/api/me');

    expect(expired.status).toBe(401);
    expect(errorOf(expired).code).toBe('UNAUTHENTICATED');
  });
});

describe('what a demo visitor can and cannot do', () => {
  it('cannot delete the account (403), and the sandbox stays', async () => {
    const { user } = await openDemo();

    const res = await t.call(user, 'DELETE', '/api/me', {
      password: 'whatever-1234',
    });

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('DEMO_ACCOUNT');
    expect((await t.call(user, 'GET', '/api/me')).status).toBe(200);
  });

  it('can import a CSV like anyone else', async () => {
    const { user } = await openDemo();
    const upload = (dry_run: boolean) =>
      t.call(user, 'POST', '/api/imports', {
        csv_base64: SAMPLE_CSV.toString('base64'),
        dry_run,
      });

    const preview = await upload(true);
    expect(preview.status, preview.text).toBe(200);
    const real = await upload(false);
    expect(real.status, real.text).toBe(200);
    expect(dataOf(real)).toMatchObject({
      dry_run: false,
      invoices_created: 11,
    });
    expect(await invoicesOf(user)).toHaveLength(14 + 11);
  });

  it('is refused a claim for a public administration and a consumer (DEBTOR_NOT_B2B) and for an unknown kind until it confirms', async () => {
    const { user } = await openDemo();
    const byKind = Object.fromEntries(
      (await debtorsOf(user)).map((d) => [d.kind, d]),
    );
    const claimFor = (id: string | undefined) =>
      t.call(user, 'POST', '/api/claims', { debtor_id: id });

    for (const kind of ['PUBLIC_ADMIN', 'CONSUMER']) {
      const res = await claimFor(byKind[kind]?.id);
      expect(res.status, kind).toBe(422);
      expect(errorOf(res).code, kind).toBe('DEBTOR_NOT_B2B');
    }
    const unknown = await claimFor(byKind.UNKNOWN?.id);
    expect(unknown.status).toBe(422);
    expect(errorOf(unknown).code).toBe('DEBTOR_KIND_UNKNOWN');

    // The confirmation step: once the visitor says it is a business, the claim goes through.
    const confirmed = await t.call(
      user,
      'PATCH',
      `/api/debtors/${byKind.UNKNOWN?.id ?? ''}`,
      {
        kind: 'BUSINESS',
      },
    );
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await claimFor(byKind.UNKNOWN?.id)).status).toBe(201);
  });

  it('goes from the demo to a letter and a sandboxed email, even when the server is live', async () => {
    const { user } = await openDemo();
    const talleres = (await debtorsOf(user)).find(
      (d) => d.name === 'Talleres Ejemplo S.L.',
    );
    if (!talleres) throw new Error('the demo has no Talleres Ejemplo');
    // A fully unpaid, overdue invoice: the partly paid one has its own test below.
    const unpaid = (await invoicesOf(user)).find(
      (i) => i.debtor_id === talleres.id && i.overdue && i.paid_cents === 0,
    );
    if (!unpaid) throw new Error('the demo has no unpaid overdue invoice');
    const sentBefore = mailer.sent.length;

    const claim = await t.call(user, 'POST', '/api/claims', {
      debtor_id: talleres.id,
      invoice_ids: [unpaid.id],
    });
    expect(claim.status, claim.text).toBe(201);
    const claimId = (dataOf(claim).claim as { id: string }).id;

    const letter = await t.call(
      user,
      'GET',
      `/api/claims/${claimId}/letter.pdf`,
    );
    expect(letter.status, letter.text).toBe(200);
    expect(letter.headers.get('content-type')).toBe('application/pdf');
    expect(letter.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const email = await t.call(
      user,
      'POST',
      `/api/claims/${claimId}/email`,
      undefined,
      {
        'Idempotency-Key': 'demo-visitor-key-1',
      },
    );
    expect(email.status, email.text).toBe(200);
    expect(dataOf(email)).toMatchObject({
      sent: true,
      mode: 'sandbox',
      delivered_to: 'sandbox',
      would_have_gone_to: 'talleres@example.com',
      event_recorded: false,
    });
    expect(mailer.sent.slice(sentBefore).map((m) => m.to)).toEqual([
      LIVE_CONFIG.testRecipient,
    ]);
  });
  it('gets a letter for the partly paid invoice, claimed after its payment exists', async () => {
    const { user } = await openDemo();
    const partly = (await invoicesOf(user)).find((i) => i.paid_cents > 0);
    if (!partly) throw new Error('the demo has no partly paid invoice');

    const claim = await t.call(user, 'POST', '/api/claims', {
      debtor_id: partly.debtor_id,
      invoice_ids: [partly.id],
    });
    expect(claim.status, claim.text).toBe(201);
    const claimId = (dataOf(claim).claim as { id: string }).id;
    const letter = await t.call(
      user,
      'GET',
      `/api/claims/${claimId}/letter.pdf`,
    );

    expect(letter.status, letter.text).toBe(200);
    expect(letter.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('cannot log in: a demo user has no password, so login answers like for an unknown email', async () => {
    await openDemo();
    // The schema does not forbid an email on a demo user, so make the worst case: one that has it.
    await t.db.query(
      "insert into users (email, is_demo, expires_at) values ('demo-login@example.com', true, now() + interval '1 day')",
    );
    const login = (email: string) =>
      t.call(null, 'POST', '/api/auth/login', {
        email,
        password: 'a-password-of-12-chars',
      });

    const unknown = await login('nobody@example.com');
    const attempt = await login('demo-login@example.com');

    expect(attempt.status).toBe(401);
    expect(errorOf(attempt).code).toBe('INVALID_CREDENTIALS');
    expect({ ...errorOf(attempt), request_id: '' }).toEqual({
      ...errorOf(unknown),
      request_id: '',
    });
    expect(attempt.headers.getSetCookie()).toEqual([]);
    // The database itself refuses a demo user that has a password.
    await expect(
      t.db.query(
        "insert into users (is_demo, password_hash, expires_at) values (true, 'hash', now())",
      ),
    ).rejects.toThrow();
  });
});
