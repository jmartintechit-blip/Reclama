import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashKeyPart } from '../db/rate-limits.ts';
import { extractPdfText, summarizePdf } from '../pdf-test-utils.ts';
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
const IBAN = 'ES91 2100 0418 4502 0005 1332';
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ now: NOW });
}, 30_000);
afterAll(async () => {
  await t.stop();
});

const COMPLETE_PROFILE = {
  business_name: 'Estudio Ficticio Norte S.L.',
  tax_id: 'B12345674',
  address: 'Calle de Ejemplo 12\n28001 Madrid',
  iban: IBAN,
};

async function setProfile(user: TestUser, profile: Record<string, unknown>) {
  const res = await t.call(user, 'PATCH', '/api/me/profile', profile);
  expect(res.status, res.text).toBe(200);
}

// A user with a complete profile and a claim of 1,000 EUR (issued 31 Aug, due 30 Sep 2026): on
// 30 Oct that is 30 days late, 8,55 EUR of interest at 10.40 %.
async function setup({
  profile = COMPLETE_PROFILE,
  debtor = { name: 'Acme S.L.', tax_id: 'A87654321' },
  number = 'F-1',
}: {
  profile?: Record<string, unknown> | null;
  debtor?: Record<string, unknown>;
  number?: string;
} = {}) {
  const user = await t.makeUser();
  if (profile !== null) await setProfile(user, profile);
  const created = await t.call(user, 'POST', '/api/invoices', {
    debtor,
    number,
    issue_date: '2026-08-31',
    due_date: '2026-09-30',
    amount_cents: 100_000,
  });
  expect(created.status, created.text).toBe(201);
  const invoice = invoiceOf(created);
  const business = await t.call(
    user,
    'PATCH',
    `/api/debtors/${invoice.debtor_id}`,
    { kind: 'BUSINESS' },
  );
  expect(business.status, business.text).toBe(200);
  const claim = await t.call(user, 'POST', '/api/claims', {
    debtor_id: invoice.debtor_id,
  });
  expect(claim.status, claim.text).toBe(201);
  const { id } = (claim.json as { data: { claim: { id: string } } }).data.claim;
  return { user, claimId: id, invoice };
}

const letter = (user: TestUser | null, claimId: string) =>
  t.call(user, 'GET', `/api/claims/${claimId}/letter.pdf`);

// The text of the letter on one line (a sentence that wraps still reads as one).
const textOf = (answer: Answer) =>
  extractPdfText(answer.bytes).replace(/\s+/g, ' ');

describe('GET /api/claims/:id/letter.pdf', () => {
  it('answers a PDF attachment with the security headers, built from the frozen claim', async () => {
    const { user, claimId } = await setup();

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="requerimiento-f-1.pdf"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(res.bytes.length));
    expect(res.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const summary = summarizePdf(res.bytes);
    expect(summary.endsWithEof).toBe(true);
    expect(summary.mediaBoxes).toHaveLength(summary.pageCount);
    for (const box of summary.mediaBoxes) {
      expect(box).toBe('/MediaBox [0 0 595.28 841.89]');
    }
    const text = textOf(res);
    for (const expected of [
      'Estudio Ficticio Norte S.L.',
      'NIF/CIF: B12345674',
      '28001 Madrid',
      'Acme S.L.',
      'NIF/CIF: A87654321',
      'F-1',
      '1.000,00 €', // principal
      '8,55 €', // interest of the claim
      '40,00 €', // compensation (PER_CLAIM, the default of a new profile)
      '1.048,55 €', // total
      '30/10/2026', // the date of the letter: today in Madrid
      'hasta el 09/11/2026', // 10 days later
      'ES91 2100 0418 4502 0005 1332',
      '31/08/2026',
      '30/09/2026',
      '10,40 %',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('keeps printing the numbers of the claim when the rates change afterwards', async () => {
    const { user, claimId } = await setup();
    const before = textOf(await letter(user, claimId));
    await t.db.query(
      `update legal_interest_rates set rate_bp = 2000, ecb_mro_bp = 1200
        where semester_start = '2026-07-01'`,
    );
    try {
      const after = await letter(user, claimId);

      expect(after.status, after.text).toBe(200);
      const text = textOf(after);
      expect(text).toContain('10,40 %');
      expect(text).not.toContain('20,00 %');
      expect(text).toContain('1.000,00 €');
      expect(text).toContain('8,55 €');
      expect(text).toBe(before);
    } finally {
      await t.db.query(
        `update legal_interest_rates set rate_bp = 1040, ecb_mro_bp = 240
          where semester_start = '2026-07-01'`,
      );
    }
  });

  it('answers 404 for a missing id, a malformed id and the claim of someone else, with the same body', async () => {
    const { claimId } = await setup();
    const other = await t.makeUser();
    await setProfile(other, COMPLETE_PROFILE);

    const answers = [
      await letter(other, claimId),
      await letter(other, MISSING_ID),
      await letter(other, 'not-a-uuid'),
    ];

    for (const res of answers) {
      expect(res.status, res.text).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(errorOf(res)).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      expect(res.text).not.toContain('%PDF');
    }
  });

  it('answers 422 PROFILE_INCOMPLETE listing what is missing', async () => {
    const { user, claimId } = await setup({
      profile: { business_name: 'Solo Nombre', address: 'Calle 1' },
    });

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'PROFILE_INCOMPLETE',
      details: [{ path: 'tax_id', message: 'Required to generate the letter' }],
    });
    expect(res.headers.get('content-type')).toContain('application/json');

    const none = await setup({ profile: null });
    const all = await letter(none.user, none.claimId);
    expect(all.status).toBe(422);
    expect(
      (errorOf(all).details as { path: string }[]).map((d) => d.path),
    ).toEqual(['business_name', 'tax_id', 'address']);
  });

  it('counts a field with nothing printable as missing', async () => {
    const { user, claimId } = await setup({
      profile: { ...COMPLETE_PROFILE, business_name: ZERO_WIDTH_SPACE },
    });

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(errorOf(res).details).toEqual([
      { path: 'business_name', message: 'Required to generate the letter' },
    ]);
  });

  it('works without an IBAN, and refuses a stored IBAN that is not valid', async () => {
    const withoutIban = await setup({
      profile: { ...COMPLETE_PROFILE, iban: null },
    });
    const ok = await letter(withoutIban.user, withoutIban.claimId);
    expect(ok.status, ok.text).toBe(200);
    expect(textOf(ok)).not.toContain('transferencia bancaria');

    const broken = await setup();
    await t.db.query('update profiles set iban = $2 where user_id = $1', [
      broken.user.id,
      'ES0000000000000000000000',
    ]);
    const refused = await letter(broken.user, broken.claimId);
    expect(refused.status, refused.text).toBe(422);
    expect(errorOf(refused)).toMatchObject({
      code: 'PROFILE_INCOMPLETE',
      details: [{ path: 'iban', message: 'Must be a valid IBAN' }],
    });
  });

  it('answers 422 LETTER_NOT_AVAILABLE for a claim whose data cannot be shown', async () => {
    const { user, claimId } = await setup();
    await t.db.query(
      `update claim_invoices set segments = '[]'::jsonb where claim_id = $1`,
      [claimId],
    );

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(422);
    expect(errorOf(res).code).toBe('LETTER_NOT_AVAILABLE');
    expect(res.text).not.toContain('%PDF');
  });

  describe('when the claim can no longer be demanded', () => {
    const expectRefused = async (
      user: TestUser,
      claimId: string,
      reason: string,
    ) => {
      const res = await letter(user, claimId);

      expect(res.status, res.text).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'CLAIM_NOT_ACTIONABLE',
        details: { reason },
      });
      expect(errorOf(res).message).not.toBe('');
      expect(res.text).not.toContain('%PDF');
    };

    it.each(['CONSUMER', 'PUBLIC_ADMIN', 'UNKNOWN'] as const)(
      'refuses with debtor_not_business when the debtor is now %s',
      async (kind) => {
        const { user, claimId, invoice } = await setup();
        await t.db.query('update debtors set kind = $2 where id = $1', [
          invoice.debtor_id,
          kind,
        ]);

        await expectRefused(user, claimId, 'debtor_not_business');
      },
    );

    it('refuses with marked_paid when the claim has a PAID event', async () => {
      const { user, claimId } = await setup();
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
      const { user, claimId, invoice } = await setup();
      const paid = await t.call(
        user,
        'POST',
        `/api/invoices/${invoice.id}/payments`,
        { paid_on: '2026-10-30', amount_cents: 100_000 },
      );
      expect(paid.status, paid.text).toBe(201);

      await expectRefused(user, claimId, 'invoice_paid');
    });

    it('refuses with invoice_changed when the amount of an invoice of the claim changed', async () => {
      const { user, claimId, invoice } = await setup();
      await t.db.query('update invoices set amount_cents = 5 where id = $1', [
        invoice.id,
      ]);

      await expectRefused(user, claimId, 'invoice_changed');
    });

    it('refuses with invoice_changed after a partial payment on an invoice of the claim', async () => {
      const { user, claimId, invoice } = await setup();
      const paid = await t.call(
        user,
        'POST',
        `/api/invoices/${invoice.id}/payments`,
        { paid_on: '2026-10-30', amount_cents: 40_000 },
      );
      expect(paid.status, paid.text).toBe(201);

      await expectRefused(user, claimId, 'invoice_changed');
    });

    it('still gives the PDF while the debtor is a business and nothing is paid (control)', async () => {
      const { user, claimId } = await setup();
      const note = await t.call(user, 'POST', `/api/claims/${claimId}/events`, {
        kind: 'NOTE',
        occurred_on: '2026-10-30',
      });
      expect(note.status, note.text).toBe(201);

      expect((await letter(user, claimId)).status).toBe(200);
    });
  });

  it('handles names that Helvetica cannot draw, and builds an ASCII file name from the claim', async () => {
    const { user, claimId } = await setup({
      debtor: { name: 'Łukasz 株式会社 S.L.', tax_id: 'Ő-1' },
      number: 'Ñandú/株-1',
    });

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(200);
    const text = textOf(res);
    expect(text).toContain('Lukasz ???? S.L.');
    expect(text).toContain('NIF/CIF: O1');
    expect(text).toContain('Ñandú/?-1'); // Windows-1252 letters stay
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="requerimiento-nandu-1.pdf"',
    );
  });

  it('falls back to the start of the claim id when the invoice number leaves nothing for a file name', async () => {
    const { user, claimId } = await setup({ number: '株式会社' });

    const res = await letter(user, claimId);

    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="requerimiento-${claimId.slice(0, 8)}.pdf"`,
    );
  });

  it('answers 401 without a session', async () => {
    const { claimId } = await setup();

    const res = await letter(null, claimId);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('%PDF');
  });

  it('has its own limit of 60 PDFs per hour for each user, apart from the write limit', async () => {
    const { user, claimId } = await setup();
    const hour = 60 * 60 * 1000;
    const windowStart = new Date(
      Math.floor(Date.parse(NOW) / hour) * hour,
    ).toISOString();
    const fill = (name: string, hits: number) =>
      t.db.query(
        `insert into rate_limits (key, window_start, hits) values ($1, $2, $3)
         on conflict (key, window_start) do update set hits = $3`,
        [`${name}:${hashKeyPart(user.id)}`, windowStart, hits],
      );

    await fill('write', 120); // a full write counter does not stop a read
    expect((await letter(user, claimId)).status).toBe(200);

    await fill('letter-pdf', 59); // this request is number 60: still allowed
    expect((await letter(user, claimId)).status).toBe(200);
    const blocked = await letter(user, claimId); // number 61
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).code).toBe('RATE_LIMITED');
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    // Only the PDF is limited: the rest of the API still answers, and so does another user.
    expect((await t.call(user, 'GET', `/api/claims/${claimId}`)).status).toBe(
      200,
    );
    const other = await setup();
    expect((await letter(other.user, other.claimId)).status).toBe(200);
  });
});
