import { describe, expect, it } from 'vitest';
import type { ISODate } from '../domain/dates.ts';
import type { InterestSegment } from '../domain/interest.ts';
import { toCents } from '../domain/money.ts';
import {
  extractPdfPageLines,
  inflatedStreams,
  extractPdfText,
  summarizePdf,
} from '../pdf-test-utils.ts';
import {
  PAYMENT_DEADLINE_DAYS,
  renderLetter,
  type LetterData,
  type LetterInvoice,
} from './letter.ts';

const date = (text: string) => text as ISODate;
const A4 = '[0 0 595.28 841.89]';

const segment = (
  start: string,
  end: string,
  days: number,
  rateBp: number,
  interest: number,
): InterestSegment => ({
  start: date(start),
  end: date(end),
  days,
  yearDays: 365,
  rateBp,
  balance: toCents(100_000),
  interest: toCents(interest),
});

function invoice(index: number, patch: Partial<LetterInvoice> = {}) {
  return {
    number: `F-2026-${String(index).padStart(3, '0')}`,
    issueDate: date('2026-05-04'),
    dueDate: date('2026-06-03'),
    dueDateEstimated: false,
    principal: toCents(100_000 + index),
    interest: toCents(3_857),
    segments: [
      segment('2026-06-04', '2026-06-30', 27, 1015, 751),
      segment('2026-07-01', '2026-09-30', 92, 1040, 2622),
      segment('2026-10-01', '2026-10-17', 17, 1040, 484),
    ],
    ...patch,
  } satisfies LetterInvoice;
}

function letter(patch: Partial<LetterData> = {}, invoices = 2): LetterData {
  return {
    letterDate: date('2026-10-18'),
    claimId: '3f2a9c10-8b7e-4c55-9d11-0a1b2c3d4e5f',
    asOf: date('2026-10-17'),
    compensationMode: 'PER_CLAIM',
    principal: toCents(200_003),
    interest: toCents(7_714),
    compensation: toCents(4_000),
    total: toCents(211_717),
    sender: {
      name: 'Estudio Ficticio Norte S.L.',
      taxId: 'B12345674',
      address: 'Calle de Ejemplo 12, 3ºB\n28001 Madrid',
      iban: 'ES9121000418450200051332',
    },
    debtor: { name: 'Distribuciones Imaginarias, S.A.', taxId: 'A87654321' },
    invoices: Array.from({ length: invoices }, (_, i) => invoice(i + 1)),
    ...patch,
  };
}

// The text of the whole letter on one line: a sentence that wraps still reads as one.
const flat = (pdf: Uint8Array) => extractPdfText(pdf).replace(/\s+/g, ' ');

describe('renderLetter', () => {
  it('produces an A4 PDF', async () => {
    const pdf = await renderLetter(letter());

    const summary = summarizePdf(pdf);
    expect(summary.startsWithMagic).toBe(true);
    expect(summary.endsWithEof).toBe(true);
    expect(summary.pageCount).toBeGreaterThanOrEqual(1);
    expect(summary.mediaBoxes).toEqual(
      Array(summary.pageCount).fill(`/MediaBox ${A4}`) as string[],
    );
  });

  it('prints the sender, the debtor, the dates, the amounts, the payment data and the legal basis', async () => {
    const text = flat(await renderLetter(letter()));

    for (const expected of [
      'Estudio Ficticio Norte S.L.',
      'NIF/CIF: B12345674',
      'Calle de Ejemplo 12, 3ºB',
      '28001 Madrid',
      'Distribuciones Imaginarias, S.A.',
      'NIF/CIF: A87654321',
      'REQUERIMIENTO DE PAGO',
      '18/10/2026', // the date of the letter
      'REQ-3F2A9C10',
      'F-2026-001',
      'F-2026-002',
      '04/05/2026', // issue date
      '03/06/2026', // due date
      '1.000,01 €', // principal of the first invoice
      '2.000,03 €', // principal total
      '77,14 €', // interest total
      '40,00 €',
      '2.117,17 €', // total claimed
      // the deadline is 10 calendar days after the letter
      `dentro de los ${String(PAYMENT_DEADLINE_DAYS)} días naturales`,
      'hasta el 28/10/2026',
      'ES91 2100 0418 4502 0005 1332',
      'Ley 3/2004',
      'Art. 4:',
      'Art. 5:',
      'Art. 7:',
      'Art. 8:',
      'plantilla generada por la herramienta Reclama',
      'No es asesoramiento jurídico',
      'Página 1 de ',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('prints the interest segments exactly as they are stored, without recalculating them', async () => {
    const odd = invoice(1, {
      interest: toCents(9_999),
      segments: [segment('2026-06-04', '2026-06-30', 27, 777, 4_321)],
    });
    const text = flat(await renderLetter(letter({ invoices: [odd] })));

    // 1.000,00 EUR at 7.77 % for 27 days would be 5,75 EUR: the stored 43,21 EUR is printed.
    expect(text).toContain('43,21 €');
    expect(text).toContain('7,77 %');
    expect(text).toContain('99,99 €');
    expect(text).not.toContain('5,75 €');
  });

  it('shows the due date of an invoice without one as an estimate, with its note', async () => {
    const withNote = flat(
      await renderLetter(
        letter({ invoices: [invoice(1, { dueDateEstimated: true })] }),
      ),
    );
    const without = flat(await renderLetter(letter()));

    expect(withNote).toContain('03/06/2026 *');
    expect(withNote).toContain('Sin fecha de pago pactada');
    expect(without).not.toContain('Sin fecha de pago pactada');
  });

  it('describes the compensation according to the mode, and leaves art. 8 out when there is none', async () => {
    const perClaim = flat(await renderLetter(letter()));
    const perInvoice = flat(
      await renderLetter(
        letter({
          compensationMode: 'PER_INVOICE',
          compensation: toCents(8_000),
        }),
      ),
    );
    const none = flat(
      await renderLetter(
        letter({ compensationMode: 'NONE', compensation: toCents(0) }),
      ),
    );

    expect(perClaim).toContain(
      'Cantidad fija de 40,00 € por esta reclamación.',
    );
    expect(perInvoice).toContain(
      'Cantidad fija de 40,00 € por cada una de las 2 facturas vencidas.',
    );
    expect(perInvoice).toContain('80,00 €');
    expect(none).not.toContain('art. 8');
    expect(none).not.toContain('Art. 8');
    expect(none).not.toContain('costes de cobro');
    expect(none).toContain('Art. 7:');
  });

  it('gives the payment instruction without an IBAN when the sender has none', async () => {
    const text = flat(
      await renderLetter(
        letter({ sender: { ...letter().sender, iban: null } }),
      ),
    );

    expect(text).not.toContain('transferencia');
    expect(text).not.toContain('ES91');
    expect(text).toContain('Para concretar la forma de pago');
  });

  it('counts the deadline in calendar days across a month and a year end', async () => {
    const text = flat(
      await renderLetter(letter({ letterDate: date('2026-12-28') })),
    );

    expect(text).toContain('hasta el 07/01/2027');
  });

  it('is the same file for the same data', async () => {
    const [one, two] = await Promise.all([
      renderLetter(letter()),
      renderLetter(letter()),
    ]);

    expect(one.equals(two)).toBe(true);
  });

  describe('a claim with many invoices', () => {
    it('breaks into pages, repeats the headers and numbers every page', async () => {
      const pdf = await renderLetter(letter({}, 60));

      const summary = summarizePdf(pdf);
      expect(summary.pageCount).toBeGreaterThan(5);
      expect(summary.mediaBoxes).toEqual(
        Array(summary.pageCount).fill(`/MediaBox ${A4}`) as string[],
      );
      const total = String(summary.pageCount);
      for (let page = 1; page <= summary.pageCount; page += 1) {
        const lines = extractPdfPageLines(pdf, page);
        expect(lines, `page ${String(page)}`).toContain(
          `Página ${String(page)} de ${total}`,
        );
        // Every table header on the page has a data row after it: no orphan header.
        for (const header of ['Emisión', 'Desde']) {
          const at = lines.lastIndexOf(header);
          if (at === -1) continue;
          expect(
            lines.slice(at).some((line) => /^\d\d\/\d\d\/\d{4}$/.test(line)),
            `page ${String(page)}: header "${header}" without rows`,
          ).toBe(true);
        }
      }
      const text = extractPdfText(pdf);
      expect(text).toContain('F-2026-001');
      expect(text).toContain('F-2026-060');
      expect(
        text.split('\n').filter((l) => l === 'Emisión').length,
      ).toBeGreaterThan(1);
    });

    it('keeps the totals and the legal basis together on one page', async () => {
      const pdf = await renderLetter(letter({}, 60));

      const pages = Array.from(
        { length: summarizePdf(pdf).pageCount },
        (_, i) => extractPdfPageLines(pdf, i + 1),
      );
      const totalsPage = pages.findIndex((lines) =>
        lines.includes('TOTAL RECLAMADO'),
      );
      expect(totalsPage).toBeGreaterThan(0);
      expect(pages[totalsPage]).toContain('Fundamento legal');
      expect(pages[totalsPage]).toContain('Atentamente,');
    });
  });
});

describe('text typed by users', () => {
  const NASTY = {
    name: 'Łukasz Ștefan Őrs \u{682E}株式会社 💸\u202E\u0000\nRevés',
    address: 'Calle\u200B Ñ 1\n株式会社\n\u202Eevil',
    taxId: 'X\u0007-\u{FF11}',
    number: 'F/ł-株-1',
  };

  it('never throws and replaces what Helvetica cannot draw', async () => {
    const pdf = await renderLetter(
      letter({
        sender: {
          ...letter().sender,
          name: NASTY.name,
          address: NASTY.address,
        },
        debtor: { name: NASTY.name, taxId: NASTY.taxId },
        invoices: [invoice(1, { number: NASTY.number })],
      }),
    );

    const text = extractPdfText(pdf);
    expect(text).toContain('Lukasz Stefan Ors');
    expect(text).toContain('Revés'); // Windows-1252 letters stay
    expect(text).toContain('Calle Ñ 1');
    expect(text).toContain('F/l-?-1');
    expect(text).toContain('NIF/CIF: X-1'); // fullwidth 1 -> 1, BEL dropped
    for (const forbidden of ['株', '💸', '\u202E', '\u0000', 'Ł', 'ł']) {
      expect(text, JSON.stringify(forbidden)).not.toContain(forbidden);
    }
  });

  it('never writes the original characters into the content of the file', async () => {
    const pdf = await renderLetter(
      letter({ debtor: { name: NASTY.name, taxId: NASTY.taxId } }),
    );

    // The inflated content streams are read as Latin-1: one character is one byte.
    const content = Buffer.from(inflatedStreams(pdf).join('\n'), 'latin1');
    for (const char of ['株', '式', '💸', 'Ł', '\u202E']) {
      expect(content.includes(Buffer.from(char, 'utf8')), char).toBe(false);
    }
    expect(content.includes(0)).toBe(false); // the NUL byte of the name
  });

  it('wraps very long strings instead of running over the margins', async () => {
    const long = 'x'.repeat(500);
    const pdf = await renderLetter(
      letter({
        sender: { ...letter().sender, name: long, address: long },
        debtor: { name: long, taxId: long },
        invoices: [invoice(1, { number: long })],
      }),
    );

    expect(summarizePdf(pdf).startsWithMagic).toBe(true);
    const lines = extractPdfText(pdf)
      .split('\n')
      .filter((line) => /^x+$/.test(line));
    // Wrapped in several lines, none wider than the text area: 483 pt hold about 107 "x" at
    // 9 pt and about 120 at 8 pt.
    expect(lines.length).toBeGreaterThan(8);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(125);
  });
});
