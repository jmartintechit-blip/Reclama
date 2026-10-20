import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALC_VERSION,
  COMPENSATION_CENTS,
  ClaimError,
  computeClaim,
  type ClaimInput,
  type ClaimInvoiceInput,
  type ClaimResult,
  type CompensationMode,
  type DebtorKind,
} from './claim.ts';
import type { ISODate } from './dates.ts';
import { RateWindowError } from './interest.ts';
import { toCents } from './money.ts';
import { parseRates } from './rates.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const rates = parseRates(JSON.parse(readFileSync(FILE, 'utf8')) as unknown);

const date = (text: string) => text as ISODate;

const AS_OF = '2026-10-30';

// 1,000 EUR due 30-09-2026: 30 days late at 10.40 % = 855.
const inv1000 = (overrides: Partial<ClaimInvoiceInput> = {}) => ({
  id: 'A',
  principal: toCents(100_000),
  issueDate: date('2026-08-31'),
  dueDate: date('2026-09-30'),
  agreedRateBp: null,
  payments: [],
  ...overrides,
});

// 500 EUR, same dates: 427.
const inv500 = (overrides: Partial<ClaimInvoiceInput> = {}) =>
  inv1000({ id: 'B', principal: toCents(50_000), ...overrides });

// Not yet due on AS_OF.
const invFuture = (overrides: Partial<ClaimInvoiceInput> = {}) =>
  inv1000({
    id: 'F',
    issueDate: date('2026-10-15'),
    dueDate: date('2026-11-14'),
    ...overrides,
  });

const claimOf = (overrides: Partial<ClaimInput> = {}): ClaimInput => ({
  asOf: date(AS_OF),
  debtorKind: 'BUSINESS',
  b2bConfirmed: false,
  compensationMode: 'PER_INVOICE',
  rates,
  invoices: [inv1000(), inv500()],
  ...overrides,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ClaimError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('claim of 1,000 EUR and 500 EUR, 30 days late', () => {
  it.each<[CompensationMode, number, number]>([
    ['PER_INVOICE', 8000, 159_282],
    ['PER_CLAIM', 4000, 155_282],
    ['NONE', 0, 151_282],
  ])('%s -> compensation %i, total %i', (compensationMode, comp, total) => {
    const claim = computeClaim(claimOf({ compensationMode }));
    expect(claim.lines.map((l) => l.interest)).toEqual([855, 427]);
    expect(claim.principal).toBe(150_000);
    expect(claim.interest).toBe(1282);
    expect(claim.compensation).toBe(comp);
    expect(claim.total).toBe(total);
    expect(claim.compensationMode).toBe(compensationMode);
    expect(claim.calcVersion).toBe(CALC_VERSION);
  });

  it('uses a fixed 40 EUR compensation', () => {
    expect(COMPENSATION_CENTS).toBe(4000);
  });
});

describe('which invoices enter the claim', () => {
  it('a not-overdue invoice adds nothing, not even 4,000, and is listed', () => {
    const claim = computeClaim(
      claimOf({ invoices: [inv1000(), invFuture(), inv500()] }),
    );
    expect(claim.lines.map((l) => l.id)).toEqual(['A', 'B']);
    expect(claim.notOverdue).toEqual(['F']);
    expect(claim.compensation).toBe(8000);
    expect(claim.total).toBe(159_282);
  });

  it('an invoice due exactly on asOf is not overdue', () => {
    const claim = computeClaim(
      claimOf({
        invoices: [inv1000(), inv500({ dueDate: date(AS_OF) })],
      }),
    );
    expect(claim.notOverdue).toEqual(['B']);
    expect(claim.compensation).toBe(4000);
  });

  it('estimates the due date as issue + 30 days when it is null', () => {
    const claim = computeClaim(
      claimOf({ invoices: [inv1000({ dueDate: null })] }),
    );
    expect(claim.lines[0]).toMatchObject({
      dueDate: '2026-09-30',
      dueDateEstimated: true,
      interest: 855,
    });
  });

  it('a settled invoice is not claimed and adds no compensation', () => {
    const claim = computeClaim(
      claimOf({
        invoices: [
          inv1000({
            payments: [
              { paidOn: date('2026-10-05'), amount: toCents(100_000) },
            ],
          }),
          inv500(),
        ],
      }),
    );
    expect(claim.settled).toEqual(['A']);
    expect(claim.lines.map((l) => l.id)).toEqual(['B']);
    expect(claim.compensation).toBe(4000);
    expect(claim.total).toBe(50_000 + 427 + 4000);
  });

  it('a payment dated after asOf has not happened yet', () => {
    const claim = computeClaim(
      claimOf({
        invoices: [
          inv1000({
            payments: [
              { paidOn: date('2026-11-05'), amount: toCents(100_000) },
            ],
          }),
        ],
      }),
    );
    expect(claim.settled).toEqual([]);
    expect(claim.lines[0]?.principal).toBe(100_000);
  });

  it('payments reduce the claimed principal and the interest', () => {
    const claim = computeClaim(
      claimOf({
        compensationMode: 'NONE',
        invoices: [
          inv1000({
            payments: [{ paidOn: date('2026-10-10'), amount: toCents(40_000) }],
          }),
        ],
      }),
    );
    expect(claim.lines[0]?.principal).toBe(60_000);
    expect(claim.lines[0]?.interest).toBe(627);
    expect(claim.principal).toBe(60_000);
    expect(claim.total).toBe(60_627);
  });

  it('freezes what claim_invoices needs for each line', () => {
    const [line] = computeClaim(claimOf({ invoices: [inv1000()] })).lines;
    expect(line).toEqual({
      id: 'A',
      principal: 100_000,
      interest: 855,
      segments: [
        {
          start: '2026-10-01',
          end: '2026-10-30',
          days: 30,
          yearDays: 365,
          rateBp: 1040,
          balance: 100_000,
          interest: 855,
        },
      ],
      warnings: [],
      dueDate: '2026-09-30',
      dueDateEstimated: false,
    });
  });
});

describe('compensation modes', () => {
  it('PER_CLAIM is 4,000 with one invoice and with several', () => {
    const one = computeClaim(
      claimOf({ compensationMode: 'PER_CLAIM', invoices: [inv1000()] }),
    );
    const three = computeClaim(
      claimOf({
        compensationMode: 'PER_CLAIM',
        invoices: [inv1000(), inv500(), inv500({ id: 'C' })],
      }),
    );
    expect(one.compensation).toBe(4000);
    expect(three.compensation).toBe(4000);
  });

  it('PER_INVOICE is 4,000 per claimed invoice', () => {
    const claim = computeClaim(
      claimOf({ invoices: [inv1000(), inv500(), inv500({ id: 'C' })] }),
    );
    expect(claim.compensation).toBe(12_000);
  });
});

describe('errors', () => {
  it('NOT_OVERDUE when every invoice is not overdue', () => {
    const input = claimOf({ invoices: [invFuture()] });
    expect(codeOf(() => computeClaim(input))).toBe('NOT_OVERDUE');
  });

  it('NOT_OVERDUE when there are no invoices', () => {
    expect(codeOf(() => computeClaim(claimOf({ invoices: [] })))).toBe(
      'NOT_OVERDUE',
    );
  });

  it('NOT_OVERDUE when everything is settled', () => {
    const settled = inv1000({
      payments: [{ paidOn: date('2026-10-05'), amount: toCents(100_000) }],
    });
    expect(codeOf(() => computeClaim(claimOf({ invoices: [settled] })))).toBe(
      'NOT_OVERDUE',
    );
  });

  it.each<[DebtorKind, boolean, string | undefined]>([
    ['BUSINESS', false, undefined],
    ['BUSINESS', true, undefined],
    ['UNKNOWN', true, undefined],
    ['UNKNOWN', false, 'DEBTOR_KIND_UNCONFIRMED'],
    ['PUBLIC_ADMIN', false, 'DEBTOR_NOT_B2B'],
    ['PUBLIC_ADMIN', true, 'DEBTOR_NOT_B2B'],
    ['CONSUMER', false, 'DEBTOR_NOT_B2B'],
    ['CONSUMER', true, 'DEBTOR_NOT_B2B'],
  ])('debtor %s, b2bConfirmed %s -> %s', (debtorKind, b2bConfirmed, code) => {
    const input = claimOf({ debtorKind, b2bConfirmed });
    expect(codeOf(() => computeClaim(input))).toBe(code);
  });

  it('checks the debtor kind before any interest work', () => {
    // Out of window and no rates at all: the interest engine would throw RateWindowError.
    const input = claimOf({
      debtorKind: 'CONSUMER',
      asOf: date('2030-01-01'),
      rates: [],
    });
    expect(codeOf(() => computeClaim(input))).toBe('DEBTOR_NOT_B2B');
  });

  it('lets RateWindowError through unchanged', () => {
    const input = claimOf({
      asOf: date('2027-01-01'),
      invoices: [inv1000({ dueDate: date('2026-12-01') })],
    });
    expect(() => computeClaim(input)).toThrow(RateWindowError);
    try {
      computeClaim(input);
    } catch (error) {
      expect((error as RateWindowError).missingSemesters).toEqual(['2027-H1']);
    }
  });

  it('rejects payments that exceed the principal', () => {
    const input = claimOf({
      invoices: [
        inv1000({
          payments: [{ paidOn: date('2026-10-05'), amount: toCents(100_001) }],
        }),
      ],
    });
    expect(() => computeClaim(input)).toThrow(RangeError);
  });
});

describe('invariants and serialization', () => {
  const sets: Record<string, ClaimInvoiceInput[]> = {
    one: [inv1000()],
    two: [inv1000(), inv500()],
    mixed: [
      inv1000(),
      invFuture(),
      inv500({
        payments: [{ paidOn: date('2026-10-10'), amount: toCents(10_000) }],
      }),
      inv500({
        id: 'S',
        payments: [{ paidOn: date('2026-10-01'), amount: toCents(50_000) }],
      }),
      inv1000({ id: 'E', dueDate: null, agreedRateBp: 1500 }),
    ],
  };

  const modes: CompensationMode[] = ['NONE', 'PER_INVOICE', 'PER_CLAIM'];

  const combos = modes.flatMap((mode) =>
    Object.keys(sets).map((set): [CompensationMode, string] => [mode, set]),
  );

  it.each(combos)(
    'total = principal + interest + compensation (%s, %s)',
    (mode, set) => {
      const claim: ClaimResult = computeClaim(
        claimOf({ compensationMode: mode, invoices: sets[set] ?? [] }),
      );
      expect(claim.total).toBe(
        claim.principal + claim.interest + claim.compensation,
      );
      expect(claim.principal).toBe(
        claim.lines.reduce((s, l) => s + l.principal, 0),
      );
      expect(claim.interest).toBe(
        claim.lines.reduce((s, l) => s + l.interest, 0),
      );
      if (mode === 'NONE') expect(claim.compensation).toBe(0);
    },
  );

  it('survives a JSON round trip', () => {
    const claim = computeClaim(
      claimOf({ invoices: [inv1000(), invFuture(), inv500()] }),
    );
    expect(JSON.parse(JSON.stringify(claim)) as unknown).toEqual(claim);
  });
});
