import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/password.ts';
import { generateToken, hashToken, SESSION_COOKIE } from '../auth/session.ts';
import { createApp } from '../app.ts';
import { findOrCreateDebtor } from '../db/debtors.ts';
import { createInvoice } from '../db/invoices.ts';
import { addPayment } from '../db/payments.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { createSession } from '../db/sessions.ts';
import { createTestDb, type TestDb } from '../db/test-db.ts';
import { date } from '../db/test-fixtures.ts';
import { createUserWithProfile } from '../db/users.ts';
import type { Clock } from '../domain/dates.ts';
import { toCents } from '../domain/money.ts';
import { close, listen } from '../test-utils.ts';

const PASSWORD = 'correct horse battery';
const WRONG = 'correct horse batterz';
const START = Date.parse('2026-10-14T10:00:00Z'); // the start of a 15 minute window
const MINUTE = 60 * 1000;
const VALID_IBAN = 'ES91 2100 0418 4502 0005 1332';
const EMPTY_PROFILE = {
  business_name: null,
  tax_id: null,
  address: null,
  iban: null,
  default_compensation: 'PER_CLAIM',
};

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };

let db: TestDb;
let server: Server;
let baseUrl: string;
let passwordHash: string;
let counter = 0;

beforeAll(async () => {
  db = await createTestDb();
  passwordHash = await hashPassword(PASSWORD); // one hash for every test user
  ({ server, baseUrl } = await listen(createApp({ db, clock })));
}, 30_000);

afterAll(async () => {
  await close(server);
  await db.close();
});

beforeEach(async () => {
  nowMs = START;
  await db.query('delete from rate_limits');
});

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

// A user with a session, created directly in the database (no argon2 per user, and the
// registration limit of the real endpoint does not get in the way).
async function makeUser(): Promise<TestUser> {
  counter += 1;
  const email = `me${String(counter)}@example.com`;
  const user = await createUserWithProfile(db, email, passwordHash);
  if (!user) throw new Error('duplicate test e-mail');
  return { ...user, cookie: await openSession(user.id) };
}

async function openSession(userId: string): Promise<string> {
  const token = generateToken();
  await createSession(
    db,
    hashToken(token),
    userId,
    new Date(START + 24 * 60 * MINUTE),
  );
  return `${SESSION_COOKIE}=${token}`;
}

// A demo user: no e-mail, no password.
async function makeDemoUser(): Promise<TestUser> {
  const { rows } = await db.query(
    `with u as (
       insert into users (is_demo, expires_at) values (true, $1) returning id
     ), p as (insert into profiles (user_id) select id from u)
     select id from u`,
    [new Date(START + 24 * 60 * MINUTE).toISOString()],
  );
  const { id } = rows[0] as { id: string };
  return { id, email: '', cookie: await openSession(id) };
}

function send(
  path: string,
  method: string,
  { body, cookie, raw }: { body?: unknown; cookie?: string; raw?: string } = {},
) {
  const payload =
    raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: payload,
  });
}

const getMe = (cookie?: string) => send('/api/me', 'GET', { cookie });
const patchProfile = (body: unknown, cookie?: string) =>
  send('/api/me/profile', 'PATCH', { body, cookie });
const deleteMe = (body: unknown, cookie?: string) =>
  send('/api/me', 'DELETE', { body, cookie });

interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: { path: string; message: string }[];
  };
}
async function errorOf(res: Response) {
  const { error } = (await res.json()) as ErrorBody;
  const { request_id: requestId, ...rest } = error;
  expect(requestId).toBe(res.headers.get('x-request-id'));
  return rest;
}

async function storedProfile(userId: string) {
  const { rows } = await db.query(
    `select business_name, tax_id, address, iban, default_compensation
       from profiles where user_id = $1`,
    [userId],
  );
  return rows[0];
}

describe('GET /api/me', () => {
  it('returns the user and the profile', async () => {
    const user = await makeUser();

    const res = await getMe(user.cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        user: { id: user.id, email: user.email, is_demo: false },
        profile: EMPTY_PROFILE,
      },
    });
  });

  it('shows the profile after it was changed', async () => {
    const user = await makeUser();
    await patchProfile({ business_name: 'Taller Pérez' }, user.cookie);

    const res = await getMe(user.cookie);

    expect(
      ((await res.json()) as { data: { profile: unknown } }).data.profile,
    ).toEqual({ ...EMPTY_PROFILE, business_name: 'Taller Pérez' });
  });

  it('returns the profile of a demo user too', async () => {
    const demo = await makeDemoUser();

    const res = await getMe(demo.cookie);

    expect(await res.json()).toEqual({
      data: {
        user: { id: demo.id, email: null, is_demo: true },
        profile: EMPTY_PROFILE,
      },
    });
  });
});

describe('PATCH /api/me/profile', () => {
  it('saves every field, trimming the text and cleaning the IBAN', async () => {
    const user = await makeUser();

    const res = await patchProfile(
      {
        business_name: '  Taller Pérez S.L.  ',
        tax_id: ' B12345678 ',
        address: 'Calle Mayor 1\n28001 Madrid',
        iban: ` ${VALID_IBAN.toLowerCase()} `,
        default_compensation: 'PER_INVOICE',
      },
      user.cookie,
    );

    const expected = {
      business_name: 'Taller Pérez S.L.',
      tax_id: 'B12345678',
      address: 'Calle Mayor 1\n28001 Madrid',
      iban: 'ES9121000418450200051332',
      default_compensation: 'PER_INVOICE',
    };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { profile: expected } });
    expect(await storedProfile(user.id)).toEqual(expected);
  });

  it('changes only the fields that are sent', async () => {
    const user = await makeUser();
    await patchProfile({ business_name: 'A', tax_id: 'B1' }, user.cookie);

    const res = await patchProfile({ address: 'Somewhere' }, user.cookie);

    expect(
      ((await res.json()) as { data: { profile: unknown } }).data.profile,
    ).toEqual({
      ...EMPTY_PROFILE,
      business_name: 'A',
      tax_id: 'B1',
      address: 'Somewhere',
    });
  });

  it('clears a text field sent as null', async () => {
    const user = await makeUser();
    await patchProfile(
      { business_name: 'A', tax_id: 'B1', iban: VALID_IBAN },
      user.cookie,
    );

    const res = await patchProfile(
      { business_name: null, iban: null },
      user.cookie,
    );

    expect(res.status).toBe(200);
    expect(await storedProfile(user.id)).toEqual({
      ...EMPTY_PROFILE,
      tax_id: 'B1',
    });
  });

  it('accepts an empty object and changes nothing', async () => {
    const user = await makeUser();
    await patchProfile({ business_name: 'A' }, user.cookie);

    const res = await patchProfile({}, user.cookie);

    expect(res.status).toBe(200);
    expect(await storedProfile(user.id)).toEqual({
      ...EMPTY_PROFILE,
      business_name: 'A',
    });
  });

  it('rejects an IBAN with a wrong checksum, saying why but not echoing it', async () => {
    const user = await makeUser();
    const wrong = 'ES92 2100 0418 4502 0005 1332';

    const res = await patchProfile(
      { iban: wrong, business_name: 'Not saved either' },
      user.cookie,
    );

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ path: 'iban', message: 'Must be a valid IBAN' }],
    });
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it.each([
    ['a Spanish IBAN of the wrong length', 'ES26 2100 0418 4502 0005 1332 9'],
    ['letters where only digits fit', 'ES91 2100 0418 4502 0005 133A'],
    ['text that is not an IBAN', 'not an iban'],
    ['an empty text', ''],
    ['too many characters', `ES${'9'.repeat(70)}`],
  ])('rejects an IBAN that is %s', async (_label, iban) => {
    const user = await makeUser();

    const res = await patchProfile({ iban }, user.cookie);

    expect(res.status).toBe(400);
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it('accepts a valid IBAN of another country', async () => {
    const user = await makeUser();

    const res = await patchProfile(
      { iban: 'gb82 west 1234 5698 7654 32' },
      user.cookie,
    );

    expect(res.status).toBe(200);
    expect((await storedProfile(user.id))?.iban).toBe('GB82WEST12345698765432');
  });

  it.each([
    ['business_name', 201],
    ['tax_id', 31],
    ['address', 501],
  ])(
    'rejects %s of %i characters, but accepts one less',
    async (field, length) => {
      const user = await makeUser();

      const tooLong = await patchProfile(
        { [field]: 'x'.repeat(length) },
        user.cookie,
      );
      const justRight = await patchProfile(
        { [field]: 'x'.repeat(length - 1) },
        user.cookie,
      );

      expect(tooLong.status).toBe(400);
      expect((await errorOf(tooLong)).details?.[0]?.path).toBe(field);
      expect(justRight.status).toBe(200);
    },
  );

  it('answers 413 to a body over the size limit and saves nothing', async () => {
    const user = await makeUser();

    const res = await patchProfile(
      { business_name: 'x'.repeat(20_000) },
      user.cookie,
    );

    expect(res.status).toBe(413);
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it.each([
    ['a NUL character', 'a\u0000b'],
    ['a line break', 'a\nb'],
    ['a tab', 'a\tb'],
    ['an escape character', 'a\u001bb'],
    ['a DEL character', 'a\u007fb'],
  ])('rejects %s in a single-line field', async (_label, value) => {
    const user = await makeUser();

    for (const field of ['business_name', 'tax_id']) {
      const res = await patchProfile({ [field]: value }, user.cookie);
      expect(res.status, field).toBe(400);
    }
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it('allows line breaks and tabs in the address but not a NUL character', async () => {
    const user = await makeUser();

    const ok = await patchProfile(
      { address: 'Line 1\r\nLine\t2' },
      user.cookie,
    );
    const nul = await patchProfile({ address: 'Line 1\u0000' }, user.cookie);

    expect(ok.status).toBe(200);
    expect(nul.status).toBe(400);
  });

  it.each([
    ['an empty string', { business_name: '' }],
    ['only spaces', { tax_id: '   ' }],
    ['a number', { business_name: 123 }],
    ['a boolean', { address: true }],
    ['an array', { business_name: ['a'] }],
    ['an object', { tax_id: { a: 1 } }],
    ['a number as IBAN', { iban: 123 }],
    ['null as compensation mode', { default_compensation: null }],
    ['an unknown compensation mode', { default_compensation: 'ALWAYS' }],
    ['a lower-case compensation mode', { default_compensation: 'none' }],
    ['a number as compensation mode', { default_compensation: 1 }],
  ])('rejects %s', async (_label, body) => {
    const user = await makeUser();

    const res = await patchProfile(body, user.cookie);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"text"'],
    ['null', 'null'],
    ['broken JSON', '{"business_name":'],
  ])('rejects a body that is %s', async (_label, raw) => {
    const user = await makeUser();

    const res = await send('/api/me/profile', 'PATCH', {
      raw,
      cookie: user.cookie,
    });

    expect(res.status).toBe(400);
    expect(await storedProfile(user.id)).toEqual(EMPTY_PROFILE);
  });

  it('rejects a request without a body', async () => {
    const user = await makeUser();

    const res = await send('/api/me/profile', 'PATCH', { cookie: user.cookie });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  it('drops unknown fields: they reach neither the profile nor another table', async () => {
    const user = await makeUser();
    const other = await makeUser();

    const res = await patchProfile(
      {
        business_name: 'Mine',
        user_id: other.id,
        is_demo: true,
        password_hash: 'x',
        email: 'attacker@example.com',
        extra: 1,
      },
      user.cookie,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { profile: { ...EMPTY_PROFILE, business_name: 'Mine' } },
    });
    expect(await storedProfile(other.id)).toEqual(EMPTY_PROFILE);
    const { rows } = await db.query(
      'select email, is_demo, password_hash from users where id = $1',
      [user.id],
    );
    expect(rows).toEqual([
      { email: user.email, is_demo: false, password_hash: passwordHash },
    ]);
  });

  it("only ever changes the profile of the session's user", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await patchProfile({ business_name: 'Business of A' }, a.cookie);

    await patchProfile({ business_name: 'Business of B' }, b.cookie);

    expect((await storedProfile(a.id))?.business_name).toBe('Business of A');
    expect((await storedProfile(b.id))?.business_name).toBe('Business of B');
  });

  it('lets a demo user fill in its profile', async () => {
    const demo = await makeDemoUser();

    const res = await patchProfile({ business_name: 'Demo SL' }, demo.cookie);

    expect(res.status).toBe(200);
  });
});

describe('authorization', () => {
  it.each([
    ['PATCH /api/me/profile', () => patchProfile({ business_name: 'x' })],
    [
      'PATCH /api/me/profile without a body',
      () => send('/api/me/profile', 'PATCH'),
    ],
    ['DELETE /api/me', () => deleteMe({ password: PASSWORD })],
    ['DELETE /api/me without a body', () => send('/api/me', 'DELETE')],
    ['GET /api/me', () => getMe()],
  ])('answers 401 to %s without a cookie', async (_label, call) => {
    const res = await call();

    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('answers 401 with a cookie that belongs to no session', async () => {
    const cookie = `${SESSION_COOKIE}=${generateToken()}`;

    expect((await patchProfile({ business_name: 'x' }, cookie)).status).toBe(
      401,
    );
    expect((await deleteMe({ password: PASSWORD }, cookie)).status).toBe(401);
  });
});

describe('DELETE /api/me', () => {
  it('deletes the account with the right password: 204, cookie cleared, session dead', async () => {
    const user = await makeUser();

    const res = await deleteMe({ password: PASSWORD }, user.cookie);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-sid=;/);
    expect(cookies[0]).toMatch(/Expires=Thu, 01 Jan 1970/);

    const after = await getMe(user.cookie);
    expect(after.status).toBe(401);
    const { rows } = await db.query('select id from users where id = $1', [
      user.id,
    ]);
    expect(rows).toEqual([]);
  });

  it('lets the same e-mail register again afterwards', async () => {
    const user = await makeUser();
    await deleteMe({ password: PASSWORD }, user.cookie);

    const again = await createUserWithProfile(db, user.email, passwordHash);

    expect(again).not.toBeNull();
    expect(again?.id).not.toBe(user.id);
  });

  it('answers a wrong password exactly like a failed login, and deletes nothing', async () => {
    const user = await makeUser();
    const failedLogin = await send('/api/auth/login', 'POST', {
      body: { email: user.email, password: WRONG },
    });

    const res = await deleteMe({ password: WRONG }, user.cookie);

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await errorOf(res)).toEqual(await errorOf(failedLogin));
    expect((await getMe(user.cookie)).status).toBe(200);
  });

  it.each([
    ['an empty password', ''],
    ['a very long password', 'x'.repeat(256)],
    ['a password with a lone surrogate', 'correct horse \ud800 battery'],
  ])('answers 401, deleting nothing, for %s', async (_label, password) => {
    const user = await makeUser();

    const res = await deleteMe({ password }, user.cookie);

    expect(res.status).toBe(401);
    expect((await getMe(user.cookie)).status).toBe(200);
  });

  it.each([
    ['no password', {}],
    ['a number as password', { password: 123456 }],
    ['null as password', { password: null }],
    ['a password over the size limit', { password: 'x'.repeat(257) }],
  ])('answers 400, deleting nothing, for %s', async (_label, body) => {
    const user = await makeUser();

    const res = await deleteMe(body, user.cookie);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect((await getMe(user.cookie)).status).toBe(200);
  });

  it('answers 400 to a request without a body', async () => {
    const user = await makeUser();

    const res = await send('/api/me', 'DELETE', { cookie: user.cookie });

    expect(res.status).toBe(400);
    expect((await getMe(user.cookie)).status).toBe(200);
  });

  it('refuses a demo user with 403 DEMO_ACCOUNT, whatever it sends', async () => {
    const demo = await makeDemoUser();

    for (const password of [PASSWORD, WRONG, '']) {
      const res = await deleteMe({ password }, demo.cookie);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual({
        code: 'DEMO_ACCOUNT',
        message: 'Demo accounts cannot be deleted',
      });
    }
    expect((await getMe(demo.cookie)).status).toBe(200);
  });

  it('only deletes the account of the session, not another one', async () => {
    const a = await makeUser();
    const b = await makeUser();

    await deleteMe({ password: PASSWORD }, a.cookie);

    expect((await getMe(b.cookie)).status).toBe(200);
  });

  it('limits the attempts to 5 per 15 minutes per user, even with the right password', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await deleteMe({ password: WRONG }, user.cookie)).status);
    }

    const limited = await deleteMe({ password: PASSWORD }, user.cookie);

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(15 * 60));
    expect((await errorOf(limited)).code).toBe('RATE_LIMITED');
    expect((await getMe(user.cookie)).status).toBe(200); // not deleted
    // Another user from the same address is not affected.
    expect((await deleteMe({ password: PASSWORD }, other.cookie)).status).toBe(
      204,
    );

    nowMs = START + 15 * MINUTE; // the next window
    expect((await deleteMe({ password: PASSWORD }, user.cookie)).status).toBe(
      204,
    );
  });

  it('counts the attempts of a demo user too, and stores only a hash of the user id', async () => {
    const demo = await makeDemoUser();
    for (let i = 0; i < 5; i += 1)
      await deleteMe({ password: WRONG }, demo.cookie);

    expect((await deleteMe({ password: WRONG }, demo.cookie)).status).toBe(429);

    const { rows } = await db.query(
      "select key from rate_limits where key like 'delete-account:%'",
    );
    expect(rows).toEqual([{ key: `delete-account:${hashKeyPart(demo.id)}` }]);
  });

  it('does not count a request that fails validation', async () => {
    const user = await makeUser();
    for (let i = 0; i < 6; i += 1) await deleteMe({}, user.cookie);

    expect((await deleteMe({ password: PASSWORD }, user.cookie)).status).toBe(
      204,
    );
  });
});

// Every table with a user_id column must end with zero rows for the deleted user. The list of
// tables is read from the database, so a table added later without ON DELETE CASCADE makes this
// fail (and one without seed rows fails the "seeded" check) instead of leaking personal data.
describe('account erasure', () => {
  async function userTables(): Promise<string[]> {
    const { rows } = await db.query(
      `select c.table_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'user_id'
          and t.table_type = 'BASE TABLE'
        order by c.table_name`,
    );
    return rows.map((row) => (row as { table_name: string }).table_name);
  }

  async function countRows(
    tables: string[],
    userId: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const { rows } = await db.query(
        `select count(*) as n from "${table}" where user_id = $1`,
        [userId],
      );
      counts[table] = (rows[0] as { n: number }).n;
    }
    return counts;
  }

  // One or more rows in every table that has a user_id (profile and session come with the user).
  async function seedEverything(user: TestUser): Promise<void> {
    const debtor = await findOrCreateDebtor(db, user.id, { name: 'Acme' });
    const invoice = await createInvoice(db, user.id, {
      debtor_id: debtor.id,
      number: 'F-1',
      issue_date: date('2026-01-10'),
      amount_cents: toCents(100_000),
    });
    await addPayment(db, user.id, invoice.id, {
      paid_on: date('2026-02-01'),
      amount_cents: toCents(1_000),
    });
    const { rows } = await db.query(
      `insert into claims (user_id, debtor_id, as_of, compensation_mode, principal_cents,
                           interest_cents, compensation_cents, total_cents, calc_version)
       values ($1, $2, '2026-10-01', 'NONE', 100000, 500, 0, 100500, 'test')
       returning id`,
      [user.id, debtor.id],
    );
    const { id: claimId } = rows[0] as { id: string };
    await db.query(
      `insert into claim_invoices (claim_id, invoice_id, user_id, principal_cents, interest_cents, segments)
       values ($1, $2, $3, 100000, 500, '[]')`,
      [claimId, invoice.id, user.id],
    );
    await db.query(
      `insert into claim_events (user_id, claim_id, kind, occurred_on)
       values ($1, $2, 'NOTE', '2026-10-02')`,
      [user.id, claimId],
    );
    await db.query(
      "insert into email_log (user_id, idempotency_key) values ($1, 'key-1')",
      [user.id],
    );
    await patchProfile({ business_name: 'Business' }, user.cookie);
  }

  it('leaves zero rows of the user in every table that has user_id, and the other user untouched', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await seedEverything(a);
    await seedEverything(b);
    const tables = await userTables();
    const beforeA = await countRows(tables, a.id);
    const beforeB = await countRows(tables, b.id);

    // The test would prove nothing without these.
    expect(tables).toEqual([
      'claim_events',
      'claim_invoices',
      'claims',
      'debtors',
      'email_log',
      'invoices',
      'payments',
      'profiles',
      'sessions',
    ]);
    for (const table of tables) {
      expect(beforeA[table], `${table} seeded for A`).toBeGreaterThan(0);
      expect(beforeB[table], `${table} seeded for B`).toBeGreaterThan(0);
    }

    const res = await deleteMe({ password: PASSWORD }, a.cookie);

    expect(res.status).toBe(204);
    const afterA = await countRows(tables, a.id);
    for (const table of tables) {
      expect(afterA[table], `${table} after the erasure`).toBe(0);
    }
    expect(await countRows(tables, b.id)).toEqual(beforeB);
    const { rows } = await db.query(
      'select count(*) as n from users where id = $1',
      [a.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
    expect((await getMe(b.cookie)).status).toBe(200);
  });
});
