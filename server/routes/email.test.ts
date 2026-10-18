import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { DEFAULT_EMAIL_CONFIG, type EmailConfig } from '../config.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { extractPdfText } from '../pdf-test-utils.ts';
import { createFakeMailer, type FakeMailer } from '../services/fake-mailer.ts';
import {
  createResendMailer,
  type MailerErrorCode,
} from '../services/mailer.ts';
import {
  errorOf,
  invoiceOf,
  startTestApp,
  type Answer,
  type TestApp,
  type TestUser,
} from './test-app.ts';

const NOW = '2026-10-30T10:00:00Z'; // 2026-10-30 in Madrid
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const DEBTOR_EMAIL = 'ana@acme.example';
const COMPLETE_PROFILE = {
  business_name: 'Estudio Ficticio Norte S.L.',
  tax_id: 'B12345674',
  address: 'Calle de Ejemplo 12\n28001 Madrid',
};
// Different from the defaults, so a test proves that the values come from the configuration.
const TEST_CONFIG: EmailConfig = {
  from: 'Reclama <sender@example.test>',
  mode: 'sandbox',
  testRecipient: 'inbox@example.test',
};

// A user with a complete profile and a claim of 1,000 EUR per invoice number (issued 31 Aug, due
// 30 Sep 2026): on 30 Oct the first one is worth 1.048,55 EUR in total. The debtor has an email
// unless `debtorEmail` is null.
async function setup(
  t: TestApp,
  {
    profile = COMPLETE_PROFILE,
    debtorEmail = DEBTOR_EMAIL,
    numbers = ['F-1'],
  }: {
    profile?: Record<string, unknown> | null;
    debtorEmail?: string | null;
    numbers?: string[];
  } = {},
) {
  const user = await t.makeUser();
  if (profile !== null) {
    const saved = await t.call(user, 'PATCH', '/api/me/profile', profile);
    expect(saved.status, saved.text).toBe(200);
  }
  let debtorId = '';
  for (const number of numbers) {
    const created = await t.call(user, 'POST', '/api/invoices', {
      ...(debtorId === ''
        ? {
            debtor: {
              name: 'Acme S.L.',
              tax_id: 'A87654321',
              ...(debtorEmail === null ? {} : { email: debtorEmail }),
            },
          }
        : { debtor_id: debtorId }),
      number,
      issue_date: '2026-08-31',
      due_date: '2026-09-30',
      amount_cents: 100_000,
    });
    expect(created.status, created.text).toBe(201);
    debtorId = invoiceOf(created).debtor_id;
  }
  const business = await t.call(user, 'PATCH', `/api/debtors/${debtorId}`, {
    kind: 'BUSINESS',
  });
  expect(business.status, business.text).toBe(200);
  const claim = await t.call(user, 'POST', '/api/claims', {
    debtor_id: debtorId,
  });
  expect(claim.status, claim.text).toBe(201);
  const { id } = (claim.json as { data: { claim: { id: string } } }).data.claim;
  return { user, claimId: id, debtorId };
}

// `key: null` sends no Idempotency-Key header at all.
const sendEmail = (
  t: TestApp,
  user: TestUser | null,
  claimId: string,
  key: string | null = randomUUID(),
) =>
  t.call(
    user,
    'POST',
    `/api/claims/${claimId}/email`,
    undefined,
    key === null ? {} : { 'Idempotency-Key': key },
  );

const claimOf = async (t: TestApp, user: TestUser, claimId: string) =>
  (
    (await t.call(user, 'GET', `/api/claims/${claimId}`)).json as {
      data: {
        claim: {
          events: { kind: string; occurred_on: string; note: string | null }[];
          next_action: { action: string };
        };
      };
    }
  ).data.claim;

async function countWhere(t: TestApp, sql: string, params: unknown[] = []) {
  const { rows } = await t.db.query(sql, params);
  return (rows[0] as { n: number }).n;
}
const emailLogCount = (t: TestApp, userId: string) =>
  countWhere(t, 'select count(*)::int as n from email_log where user_id = $1', [
    userId,
  ]);

const userLimitKey = (userId: string) => `email-user:${hashKeyPart(userId)}`;
// The hits of a counter in the current window; [] when there is no row.
const hitsOf = async (t: TestApp, key: string) =>
  (
    (await t.db.query('select hits from rate_limits where key = $1', [key]))
      .rows as { hits: number }[]
  ).map((row) => row.hits);

// The windows of the daily limits are UTC days, counted from the epoch.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (iso: string) =>
  new Date(Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS).toISOString();
const fillCounter = (t: TestApp, key: string, hits: number) =>
  t.db.query(
    `insert into rate_limits (key, window_start, hits) values ($1, $2, $3)
     on conflict (key, window_start) do update set hits = $3`,
    [key, dayStart(NOW), hits],
  );

describe('POST /api/claims/:id/email with a fake mailer', () => {
  const config: EmailConfig = { ...TEST_CONFIG };
  const mailer: FakeMailer = createFakeMailer();
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ now: NOW, mailer, emailConfig: config });
  }, 30_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    Object.assign(config, TEST_CONFIG);
    mailer.failWith(null);
    mailer.sent.length = 0;
    mailer.attempts.length = 0;
    // The global counter is shared by every user of the test database.
    await t.db.query(`delete from rate_limits where key = 'email-global'`);
  });

  it('in sandbox mode sends to the test recipient, marked as a test, and records nothing in the claim', async () => {
    const { user, claimId } = await setup(t);
    const before = await claimOf(t, user, claimId);

    const res = await sendEmail(t, user, claimId, 'my-key-0001');

    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      data: {
        sent: true,
        mode: 'sandbox',
        delivered_to: 'sandbox',
        would_have_gone_to: DEBTOR_EMAIL,
        event_recorded: false,
        provider_id: 'fake-1',
      },
    });
    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0];
    expect(message?.to).toBe('inbox@example.test');
    expect(message?.from).toBe('Reclama <sender@example.test>');
    expect(message?.subject).toBe('[PRUEBA] Requerimiento de pago F-1');
    const lines = message?.text.split('\n') ?? [];
    expect(lines[0]).toBe(
      `[PRUEBA] Este mensaje se habría enviado a ${DEBTOR_EMAIL}. No se ha enviado al deudor.`,
    );
    for (const expected of [
      'Estudio Ficticio Norte S.L.',
      '1.048,55 €',
      '30/10/2026',
      'hasta el 09/11/2026 (inclusive)',
      'no constituye asesoramiento jurídico',
    ]) {
      expect(message?.text, expected).toContain(expected);
    }
    expect(message?.html).toBeUndefined();
    expect(message?.idempotencyKey).toBe(`${claimId}:my-key-0001`);
    expect(message?.attachments).toHaveLength(1);
    const attachment = message?.attachments[0];
    expect(attachment?.filename).toBe('requerimiento-f-1.pdf');
    expect(attachment?.contentType).toBe('application/pdf');
    expect(attachment?.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(extractPdfText(attachment?.content ?? Buffer.alloc(0))).toContain(
      '1.048,55 €',
    );
    // The debtor was not notified: nothing moves in the claim.
    const after = await claimOf(t, user, claimId);
    expect(after.events).toEqual([]);
    expect(after.next_action.action).toBe(before.next_action.action);
    expect(res.text).not.toContain('my-key-0001');
    // The configured test recipient is not echoed back (it was used, as the message above shows).
    expect(res.text).not.toContain('inbox@example.test');
  });

  it('in live mode sends to the debtor and records the demand, so the next action advances', async () => {
    config.mode = 'live';
    const { user, claimId } = await setup(t);
    const before = await claimOf(t, user, claimId);

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      data: {
        sent: true,
        mode: 'live',
        delivered_to: DEBTOR_EMAIL,
        would_have_gone_to: null,
        event_recorded: true,
        provider_id: 'fake-1',
      },
    });
    const message = mailer.sent[0];
    expect(message?.to).toBe(DEBTOR_EMAIL);
    expect(message?.subject).toBe('Requerimiento de pago F-1');
    expect(message?.text).not.toContain('PRUEBA');
    expect(message?.text.startsWith('A la atención de Acme S.L.:')).toBe(true);
    const after = await claimOf(t, user, claimId);
    expect(after.events).toEqual([
      {
        id: expect.any(String) as string,
        kind: 'DEMAND_SENT',
        occurred_on: '2026-10-30',
        note: 'Sent by email',
      },
    ]);
    expect(before.next_action.action).toBe('SEND_REMINDER');
    expect(after.next_action.action).toBe('SEND_BUROFAX');
  });

  it('forces a demo account to the sandbox even in live mode', async () => {
    config.mode = 'live';
    const { user, claimId } = await setup(t);
    await t.db.query(
      `update users set is_demo = true, password_hash = null, email = null,
              expires_at = $2 where id = $1`,
      [user.id, new Date(Date.parse(NOW) + DAY_MS).toISOString()],
    );

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      data: {
        mode: 'sandbox',
        delivered_to: 'sandbox',
        would_have_gone_to: DEBTOR_EMAIL,
        event_recorded: false,
      },
    });
    expect(mailer.sent.map((m) => m.to)).toEqual(['inbox@example.test']);
    expect((await claimOf(t, user, claimId)).events).toEqual([]);
  });

  it('answers 400 when the Idempotency-Key is missing or malformed, before anything else', async () => {
    const { user, claimId } = await setup(t);
    const bad: (string | null)[] = [
      null,
      '',
      'short12', // 7 characters
      'a'.repeat(129),
      'has space 1234',
      'dots.are.not.ok',
      'slash/is/not/ok',
    ];

    for (const key of bad) {
      const res = await sendEmail(t, user, claimId, key);
      expect(res.status, String(key)).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ path: 'Idempotency-Key' }],
      });
    }
    // The limits for the shortest and the longest valid key.
    expect((await sendEmail(t, user, claimId, 'a'.repeat(8))).status).toBe(200);
    expect((await sendEmail(t, user, claimId, 'b'.repeat(128))).status).toBe(
      200,
    );
    // The key is checked before the claim is looked up.
    expect((await sendEmail(t, user, MISSING_ID, null)).status).toBe(400);
    expect(mailer.sent).toHaveLength(2);
    expect(await emailLogCount(t, user.id)).toBe(2);
  });

  it('refuses a replay of the same key with 409 and sends only one email', async () => {
    const { user, claimId } = await setup(t);

    const first = await sendEmail(t, user, claimId, 'same-key-1234');
    const second = await sendEmail(t, user, claimId, 'same-key-1234');

    expect(first.status, first.text).toBe(200);
    expect(second.status, second.text).toBe(409);
    expect(errorOf(second).code).toBe('EMAIL_ALREADY_SENT');
    expect(mailer.attempts).toHaveLength(1);
    // Another key is another send.
    const third = await sendEmail(t, user, claimId, 'other-key-1234');
    expect(third.status, third.text).toBe(200);
    expect(mailer.sent).toHaveLength(2);
  });

  it('gives the key back when the provider fails, so the same key can be retried', async () => {
    const { user, claimId } = await setup(t);
    mailer.failWith('PROVIDER_UNAVAILABLE');

    const failed = await sendEmail(t, user, claimId, 'retry-key-1234');

    expect(failed.status, failed.text).toBe(502);
    expect(await emailLogCount(t, user.id)).toBe(0);
    mailer.failWith(null);
    const retried = await sendEmail(t, user, claimId, 'retry-key-1234');
    expect(retried.status, retried.text).toBe(200);
    expect(await emailLogCount(t, user.id)).toBe(1);
    expect(mailer.attempts).toHaveLength(2);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.attempts[1]?.idempotencyKey).toBe(
      mailer.attempts[0]?.idempotencyKey,
    ); // the provider sees the same key twice: that is what makes the retry safe
  });

  it('a replay burns no quota: the user and the global counters stay where the first send left them', async () => {
    const { user, claimId } = await setup(t);

    expect((await sendEmail(t, user, claimId, 'replay-key-1234')).status).toBe(
      200,
    );
    for (let i = 0; i < 5; i += 1) {
      const replay = await sendEmail(t, user, claimId, 'replay-key-1234');
      expect(replay.status).toBe(409);
    }

    expect(await hitsOf(t, userLimitKey(user.id))).toEqual([1]);
    expect(await hitsOf(t, 'email-global')).toEqual([1]);
    // So the user still has their 2 other emails of the day.
    expect((await sendEmail(t, user, claimId)).status).toBe(200);
    expect((await sendEmail(t, user, claimId)).status).toBe(200);
    expect((await sendEmail(t, user, claimId)).status).toBe(429);
  });

  it('a user at 3 of 3 gets 429 and the key of that request stays free for later', async () => {
    const { user, claimId } = await setup(t);
    for (let i = 0; i < 3; i += 1) {
      expect((await sendEmail(t, user, claimId)).status).toBe(200);
    }

    const blocked = await sendEmail(t, user, claimId, 'later-key-12345');

    expect(blocked.status, blocked.text).toBe(429);
    expect(await emailLogCount(t, user.id)).toBe(3); // the key was released
    expect(mailer.attempts).toHaveLength(3);
    t.setNow('2026-10-31T00:00:30Z');
    try {
      const later = await sendEmail(t, user, claimId, 'later-key-12345');
      expect(later.status, later.text).toBe(200); // not 409: the key was never spent
    } finally {
      t.setNow(NOW);
    }
  });

  it('when the global limit refuses, the user keeps the quota counted before it and the key is free', async () => {
    const { user, claimId } = await setup(t);
    await fillCounter(t, 'email-global', 20);

    const blocked = await sendEmail(t, user, claimId, 'global-key-1234');

    expect(blocked.status, blocked.text).toBe(429);
    expect(await hitsOf(t, userLimitKey(user.id))).toEqual([]); // counted, then given back
    expect(await emailLogCount(t, user.id)).toBe(0);
    await t.db.query(`delete from rate_limits where key = 'email-global'`);
    const retried = await sendEmail(t, user, claimId, 'global-key-1234');
    expect(retried.status, retried.text).toBe(200);
    expect(await hitsOf(t, userLimitKey(user.id))).toEqual([1]);
  });

  it('a definite provider failure gives the quota back, so failures do not use up the 3 emails of the day', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { user, claimId } = await setup(t);
      mailer.failWith('PROVIDER_REJECTED');

      for (let i = 0; i < 5; i += 1) {
        const failed = await sendEmail(t, user, claimId);
        expect(failed.status, failed.text).toBe(502);
      }

      expect(await hitsOf(t, userLimitKey(user.id))).toEqual([]);
      expect(await hitsOf(t, 'email-global')).toEqual([]);
      expect(await emailLogCount(t, user.id)).toBe(0);
      mailer.failWith(null);
      for (let i = 0; i < 3; i += 1) {
        expect((await sendEmail(t, user, claimId)).status).toBe(200);
      }
      expect(await hitsOf(t, userLimitKey(user.id))).toEqual([3]);
      expect(await hitsOf(t, 'email-global')).toEqual([3]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('an unavailable provider (outcome unknown) frees the key but keeps the quota spent', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { user, claimId } = await setup(t);
      mailer.failWith('PROVIDER_UNAVAILABLE');

      const failed = await sendEmail(t, user, claimId);

      expect(failed.status, failed.text).toBe(502);
      expect(await hitsOf(t, userLimitKey(user.id))).toEqual([1]);
      expect(await hitsOf(t, 'email-global')).toEqual([1]);
      expect(await emailLogCount(t, user.id)).toBe(0); // the key is free for a retry
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a failure after earlier sends gives back only its own hit', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { user, claimId } = await setup(t);
      expect((await sendEmail(t, user, claimId)).status).toBe(200);
      mailer.failWith('PROVIDER_REJECTED');

      expect((await sendEmail(t, user, claimId)).status).toBe(502);

      expect(await hitsOf(t, userLimitKey(user.id))).toEqual([1]);
      expect(await hitsOf(t, 'email-global')).toEqual([1]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a letter that cannot be built gives the quota back too', async () => {
    const { user, claimId } = await setup(t);
    await t.db.query(
      `update claim_invoices set segments = '[]'::jsonb where claim_id = $1`,
      [claimId],
    );

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(await hitsOf(t, userLimitKey(user.id))).toEqual([]);
    expect(await hitsOf(t, 'email-global')).toEqual([]);
  });

  describe('when the claim can no longer be demanded', () => {
    const invoiceIdOf = async (claimId: string) =>
      (
        (
          await t.db.query(
            'select invoice_id from claim_invoices where claim_id = $1',
            [claimId],
          )
        ).rows[0] as { invoice_id: string }
      ).invoice_id;

    const expectRefused = async (
      user: TestUser,
      claimId: string,
      reason: string,
    ) => {
      const res = await sendEmail(t, user, claimId, 'actionable-key-12');

      expect(res.status, res.text).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'CLAIM_NOT_ACTIONABLE',
        details: { reason },
      });
      expect(errorOf(res).message).not.toBe('');
      // Nothing was sent, claimed or counted.
      expect(mailer.attempts).toHaveLength(0);
      expect(await emailLogCount(t, user.id)).toBe(0);
      expect(await hitsOf(t, userLimitKey(user.id))).toEqual([]);
      expect(await hitsOf(t, 'email-global')).toEqual([]);
    };

    it.each(['CONSUMER', 'PUBLIC_ADMIN', 'UNKNOWN'] as const)(
      'refuses with debtor_not_business when the debtor is now %s',
      async (kind) => {
        const { user, claimId, debtorId } = await setup(t);
        await t.db.query('update debtors set kind = $2 where id = $1', [
          debtorId,
          kind,
        ]);

        await expectRefused(user, claimId, 'debtor_not_business');
      },
    );

    it('refuses with marked_paid when the claim has a PAID event', async () => {
      const { user, claimId } = await setup(t);
      const marked = await t.call(
        user,
        'POST',
        `/api/claims/${claimId}/events`,
        { kind: 'PAID', occurred_on: '2026-10-30' },
      );
      expect(marked.status, marked.text).toBe(201);

      await expectRefused(user, claimId, 'marked_paid');
    });

    it('refuses with invoice_paid when an invoice of the claim is now paid', async () => {
      const { user, claimId } = await setup(t);
      const paid = await t.call(
        user,
        'POST',
        `/api/invoices/${await invoiceIdOf(claimId)}/payments`,
        { paid_on: '2026-10-30', amount_cents: 100_000 },
      );
      expect(paid.status, paid.text).toBe(201);

      await expectRefused(user, claimId, 'invoice_paid');
    });

    it('refuses with invoice_changed after a partial payment, and sends nothing', async () => {
      const { user, claimId } = await setup(t);
      const paid = await t.call(
        user,
        'POST',
        `/api/invoices/${await invoiceIdOf(claimId)}/payments`,
        { paid_on: '2026-10-30', amount_cents: 40_000 },
      );
      expect(paid.status, paid.text).toBe(201);

      await expectRefused(user, claimId, 'invoice_changed');
    });

    it('also refuses when only one invoice of several is paid', async () => {
      const { user, claimId } = await setup(t, { numbers: ['F-1', 'F-2'] });
      await t.db.query(
        `update invoices set status = 'PAID'
          where id = (select invoice_id from claim_invoices where claim_id = $1 limit 1)`,
        [claimId],
      );

      await expectRefused(user, claimId, 'invoice_paid');
    });

    it('still sends a claim whose invoices are open and whose debtor is a business (control)', async () => {
      const { user, claimId } = await setup(t);

      const res = await sendEmail(t, user, claimId, 'actionable-key-12');

      expect(res.status, res.text).toBe(200);
      expect(mailer.sent).toHaveLength(1);
    });

    it('is checked after the profile check and before the limits', async () => {
      const { user, claimId, debtorId } = await setup(t, { profile: null });
      await t.db.query(`update debtors set kind = 'CONSUMER' where id = $1`, [
        debtorId,
      ]);

      const res = await sendEmail(t, user, claimId);

      expect(errorOf(res).code).toBe('PROFILE_INCOMPLETE');
    });
  });

  describe('with the provider failing', () => {
    let consoleError: MockInstance<typeof console.error>;
    beforeEach(() => {
      consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
    });
    afterEach(() => {
      consoleError.mockRestore();
    });

    it.each<[MailerErrorCode, string]>([
      ['PROVIDER_UNAVAILABLE', 'unavailable'],
      ['PROVIDER_RATE_LIMITED', 'rate_limited'],
      ['PROVIDER_REJECTED', 'rejected'],
      ['PROVIDER_INVALID', 'invalid'],
    ])(
      '%s answers 502 with the reason %s and nothing from the provider',
      async (code, reason) => {
        const { user, claimId } = await setup(t);
        mailer.failWith(code);

        const res = await sendEmail(t, user, claimId, 'failing-key-1234');

        expect(res.status, res.text).toBe(502);
        expect(res.json).toEqual({
          error: {
            code: 'EMAIL_PROVIDER_ERROR',
            message: 'The email could not be sent, try again later',
            request_id: res.headers.get('x-request-id'),
            details: { reason },
          },
        });
        expect(consoleError).toHaveBeenCalledOnce();
        expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
          level: 'error',
          request_id: res.headers.get('x-request-id'),
          error_name: 'MailerError',
          reason,
        });
        expect((await claimOf(t, user, claimId)).events).toEqual([]);
      },
    );
  });

  it('answers 404 for a missing, a malformed and a foreign claim, and sends nothing', async () => {
    const { claimId } = await setup(t);
    const other = await t.makeUser();

    const answers = [
      await sendEmail(t, other, claimId),
      await sendEmail(t, other, MISSING_ID),
      await sendEmail(t, other, 'not-a-uuid'),
    ];

    for (const res of answers) {
      expect(res.status, res.text).toBe(404);
      expect(errorOf(res)).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.text).not.toContain(claimId);
    }
    expect(mailer.attempts).toHaveLength(0);
    expect(await emailLogCount(t, other.id)).toBe(0);
  });

  it('answers 401 without a session', async () => {
    const { claimId } = await setup(t);

    const res = await sendEmail(t, null, claimId);

    expect(res.status).toBe(401);
    expect(mailer.attempts).toHaveLength(0);
  });

  it.each(['sandbox', 'live'] as const)(
    'answers 422 DEBTOR_EMAIL_MISSING in %s mode when the debtor has no email, even before the profile check',
    async (mode) => {
      config.mode = mode;
      const { user, claimId } = await setup(t, {
        debtorEmail: null,
        profile: null,
      });

      const res = await sendEmail(t, user, claimId);

      expect(res.status, res.text).toBe(422);
      expect(errorOf(res).code).toBe('DEBTOR_EMAIL_MISSING');
      expect(mailer.attempts).toHaveLength(0);
      expect(await emailLogCount(t, user.id)).toBe(0);
    },
  );

  it('answers 422 PROFILE_INCOMPLETE listing what is missing, with the same rule as the letter', async () => {
    const { user, claimId } = await setup(t, {
      profile: { business_name: 'Solo Nombre', address: 'Calle 1' },
    });

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'PROFILE_INCOMPLETE',
      details: [{ path: 'tax_id', message: 'Required to generate the letter' }],
    });
    expect(mailer.attempts).toHaveLength(0);
    expect(await emailLogCount(t, user.id)).toBe(0);
  });

  it('answers 422 LETTER_NOT_AVAILABLE when the letter cannot be built, and gives the key back', async () => {
    const { user, claimId } = await setup(t);
    await t.db.query(
      `update claim_invoices set segments = '[]'::jsonb where claim_id = $1`,
      [claimId],
    );

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(errorOf(res).code).toBe('LETTER_NOT_AVAILABLE');
    expect(mailer.attempts).toHaveLength(0);
    expect(await emailLogCount(t, user.id)).toBe(0);
  });

  it('limits each user to 3 emails a day and refuses the fourth before claiming its key', async () => {
    const { user, claimId } = await setup(t);
    const other = await setup(t);

    for (let i = 0; i < 3; i += 1) {
      const ok = await sendEmail(t, user, claimId);
      expect(ok.status, ok.text).toBe(200);
    }
    const blocked = await sendEmail(t, user, claimId, 'fourth-key-1234');

    expect(blocked.status, blocked.text).toBe(429);
    expect(errorOf(blocked).code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(mailer.sent).toHaveLength(3);
    expect(await emailLogCount(t, user.id)).toBe(3); // the fourth key was not claimed
    // Another user is not affected.
    expect((await sendEmail(t, other.user, other.claimId)).status).toBe(200);
    // The next UTC day starts a new window.
    t.setNow('2026-10-31T00:00:30Z');
    try {
      expect(
        (await sendEmail(t, user, claimId, 'fourth-key-1234')).status,
      ).toBe(200);
    } finally {
      t.setNow(NOW);
    }
  });

  it('limits the whole service to 20 emails a day, with a counter key that holds no user data', async () => {
    const { user, claimId } = await setup(t);
    await fillCounter(t, 'email-global', 19);

    const last = await sendEmail(t, user, claimId); // number 20: still allowed
    const blocked = await sendEmail(t, user, claimId); // number 21

    expect(last.status, last.text).toBe(200);
    expect(blocked.status, blocked.text).toBe(429);
    expect(errorOf(blocked).code).toBe('RATE_LIMITED');
    expect(mailer.sent).toHaveLength(1);
    const { rows } = await t.db.query(
      `select key from rate_limits where key like 'email-%' order by key`,
    );
    const keys = (rows as { key: string }[]).map((row) => row.key);
    expect(keys).toContain('email-global');
    expect(keys).toContain(`email-user:${hashKeyPart(user.id)}`);
    expect(keys.join(' ')).not.toContain(user.id);
  });

  it('builds the subject from the invoice numbers: all of them up to three, then a count, with invisible characters removed', async () => {
    const many = await setup(t, {
      numbers: ['F-1', 'F-2', 'F-3', 'F-4', 'F-5'],
    });
    const hidden = await setup(t, { numbers: ['F​-7‮'] });

    expect((await sendEmail(t, many.user, many.claimId)).status).toBe(200);
    expect((await sendEmail(t, hidden.user, hidden.claimId)).status).toBe(200);

    expect(mailer.sent[0]?.subject).toBe(
      '[PRUEBA] Requerimiento de pago F-1, F-2, F-3 y 2 más',
    );
    expect(mailer.sent[1]?.subject).toBe('[PRUEBA] Requerimiento de pago F-7');
  });

  it('still answers 200 and keeps the key claimed when the demand cannot be recorded after the email went out', async () => {
    config.mode = 'live';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { user, claimId } = await setup(t);
    await t.db.query(`
      create function fail_claim_events() returns trigger language plpgsql as
      $$ begin raise exception 'secret internal detail'; end $$;
      create trigger fail_claim_events before insert on claim_events
        for each row execute function fail_claim_events();
    `);
    try {
      const res = await sendEmail(t, user, claimId, 'event-fails-1234');
      const replay = await sendEmail(t, user, claimId, 'event-fails-1234');

      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({
        data: { mode: 'live', event_recorded: false },
      });
      expect(replay.status).toBe(409); // the email is out: it must not be sent again
      expect(mailer.sent).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledOnce();
      const line = String(consoleError.mock.calls[0]?.[0]);
      expect(line).not.toContain('secret internal detail');
      expect(Object.keys(JSON.parse(line) as object)).toEqual([
        'level',
        'request_id',
        'error_name',
      ]);
    } finally {
      consoleError.mockRestore();
      await t.db.query(`
        drop trigger fail_claim_events on claim_events;
        drop function fail_claim_events();
      `);
    }
  });
});

describe('POST /api/claims/:id/email with the Resend mailer and a fake fetch', () => {
  const API_KEY = 're_fake_key_for_tests_only';
  const PROVIDER_TEXT = 'The acme.test domain is not verified (secret detail)';
  let t: TestApp;
  let providerFetch: typeof fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let consoleError: MockInstance<typeof console.error>;
  let consoleWarn: MockInstance<typeof console.warn>;
  let consoleLog: MockInstance<typeof console.log>;

  beforeAll(async () => {
    t = await startTestApp({
      now: NOW,
      emailConfig: TEST_CONFIG,
      mailer: createResendMailer({
        apiKey: API_KEY,
        timeoutMs: 100,
        fetchFn: (input, init) => {
          calls.push({ url: input as string, init: init ?? {} });
          return providerFetch(input, init);
        },
      }),
    });
  }, 30_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    calls.length = 0;
    providerFetch = () =>
      Promise.resolve(Response.json({ id: 'resend-msg-1' }, { status: 200 }));
    consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await t.db.query(`delete from rate_limits where key = 'email-global'`);
  });
  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  const everythingLogged = () =>
    [consoleError, consoleWarn, consoleLog]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join('\n');

  it('sends the key, the idempotency key and the JSON body that the provider expects', async () => {
    const { user, claimId } = await setup(t);

    const res = await sendEmail(t, user, claimId, 'wire-key-12345');

    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ data: { provider_id: 'resend-msg-1' } });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? { url: '', init: {} };
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Idempotency-Key': `${claimId}:wire-key-12345`,
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'attachments',
      'from',
      'subject',
      'text',
      'to',
    ]);
    expect(body).toMatchObject({
      from: 'Reclama <sender@example.test>',
      to: ['inbox@example.test'],
      subject: '[PRUEBA] Requerimiento de pago F-1',
    });
    const [attachment] = body.attachments as {
      filename: string;
      content: string;
      content_type: string;
    }[];
    expect(attachment?.filename).toBe('requerimiento-f-1.pdf');
    expect(attachment?.content_type).toBe('application/pdf');
    expect(
      Buffer.from(attachment?.content ?? '', 'base64')
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
  });

  it('keeps the provider text, the key and the addresses out of the answer and the logs when the provider refuses', async () => {
    const { user, claimId } = await setup(t);
    providerFetch = () =>
      Promise.resolve(
        Response.json(
          { name: 'validation_error', message: PROVIDER_TEXT },
          { status: 403 },
        ),
      );

    const res = await sendEmail(t, user, claimId, 'refused-key-123');

    expect(res.status, res.text).toBe(502);
    expect(errorOf(res).details).toEqual({ reason: 'rejected' });
    const logged = everythingLogged();
    for (const secret of [
      API_KEY,
      PROVIDER_TEXT,
      'acme.test',
      DEBTOR_EMAIL,
      'inbox@example.test',
      'refused-key-123',
      'Estudio Ficticio',
    ]) {
      expect(res.text, secret).not.toContain(secret);
      expect(logged, secret).not.toContain(secret);
    }
    expect(logged).not.toBe('');
    expect(await emailLogCount(t, user.id)).toBe(0);
  });

  it('answers 502 unavailable when the provider never answers, and the same key then works', async () => {
    const { user, claimId } = await setup(t);
    providerFetch = () => new Promise<Response>(() => undefined);

    const timedOut = await sendEmail(t, user, claimId, 'slow-key-12345');

    expect(timedOut.status, timedOut.text).toBe(502);
    expect(errorOf(timedOut).details).toEqual({ reason: 'unavailable' });
    providerFetch = () =>
      Promise.resolve(Response.json({ id: 'resend-msg-2' }, { status: 200 }));
    const retried = await sendEmail(t, user, claimId, 'slow-key-12345');
    expect(retried.status, retried.text).toBe(200);
    expect(
      calls.map(
        (c) => (c.init.headers as Record<string, string>)['Idempotency-Key'],
      ),
    ).toEqual([`${claimId}:slow-key-12345`, `${claimId}:slow-key-12345`]);
  });

  it('answers 502 unavailable on a network error and 502 rate_limited when the provider says 429', async () => {
    const { user, claimId } = await setup(t);
    providerFetch = () => Promise.reject(new TypeError('fetch failed'));
    const network: Answer = await sendEmail(t, user, claimId);
    providerFetch = () =>
      Promise.resolve(Response.json({ message: 'slow down' }, { status: 429 }));
    const limited = await sendEmail(t, user, claimId);

    expect(network.status).toBe(502);
    expect(errorOf(network).details).toEqual({ reason: 'unavailable' });
    expect(limited.status).toBe(502);
    expect(errorOf(limited).details).toEqual({ reason: 'rate_limited' });
  });
});

describe('POST /api/claims/:id/email without a mailer', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ now: NOW });
  }, 30_000);
  afterAll(async () => {
    await t.stop();
  });

  it('answers 503 EMAIL_NOT_CONFIGURED, after the claim is found and without counting a limit or claiming a key', async () => {
    const { user, claimId } = await setup(t);
    const other = await t.makeUser();

    const res = await sendEmail(t, user, claimId);
    const foreign = await sendEmail(t, other, claimId);

    expect(res.status, res.text).toBe(503);
    expect(errorOf(res).code).toBe('EMAIL_NOT_CONFIGURED');
    expect(foreign.status).toBe(404); // not found comes first: nothing is learnt about the claim
    expect(await emailLogCount(t, user.id)).toBe(0);
    expect(
      await countWhere(
        t,
        `select count(*)::int as n from rate_limits where key like 'email-%'`,
      ),
    ).toBe(0);
    // The rest of the API keeps working.
    expect((await t.call(user, 'GET', `/api/claims/${claimId}`)).status).toBe(
      200,
    );
  });
});

describe('POST /api/claims/:id/email without a configuration', () => {
  const mailer = createFakeMailer();
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ now: NOW, mailer });
  }, 30_000);
  afterAll(async () => {
    await t.stop();
  });

  it('falls back to the sandbox and the Resend test inbox, never to the debtor', async () => {
    const { user, claimId } = await setup(t);

    const res = await sendEmail(t, user, claimId);

    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      data: { mode: 'sandbox', delivered_to: 'sandbox' },
    });
    expect(res.text).not.toContain('delivered@resend.dev');
    expect(mailer.sent[0]?.to).toBe(DEFAULT_EMAIL_CONFIG.testRecipient);
    expect(mailer.sent[0]?.from).toBe('Reclama <onboarding@resend.dev>');
    expect(mailer.sent[0]?.subject.startsWith('[PRUEBA] ')).toBe(true);
  });
});
