import { describe, expect, it } from 'vitest';
import { claimDetail, claimEvent } from '../test/fixtures.ts';
import {
  fillTemplate,
  joinWithY,
  PAYMENT_DEADLINE_DAYS,
  TEMPLATE_GAP,
  templateValues,
} from './claims.ts';
import { addDays } from './dates.ts';
import { formatEUR } from './format.ts';

describe('fillTemplate', () => {
  it('fills every placeholder, each occurrence', () => {
    expect(
      fillTemplate('{{a}} y {{b}}; otra vez {{a}}', { a: 'uno', b: 'dos' }),
    ).toEqual({ text: 'uno y dos; otra vez uno', missing: [] });
  });

  it('leaves a visible gap and reports what is missing, once', () => {
    expect(
      fillTemplate('{{a}} {{b}} {{b}} {{c}}', { a: 'uno', c: '' }),
    ).toEqual({
      text: `uno ${TEMPLATE_GAP} ${TEMPLATE_GAP} ${TEMPLATE_GAP}`,
      missing: ['b', 'c'],
    });
  });

  it('does not substitute again a value that holds a placeholder', () => {
    expect(
      fillTemplate('{{a}} / {{total}}', {
        a: 'cobro de {{total}}',
        total: '10',
      }).text,
    ).toBe('cobro de {{total}} / 10');
  });
});

describe('joinWithY', () => {
  it.each([
    [[], ''],
    [['A'], 'A'],
    [['A', 'B'], 'A y B'],
    [['A', 'B', 'C'], 'A, B y C'],
  ])('joins %j as %j', (items, text) => {
    expect(joinWithY(items)).toBe(text);
  });
});

describe('templateValues', () => {
  const { claim } = claimDetail();

  it('takes the claim figures, the sender and the deadline of the letter', () => {
    const values = templateValues(claim, '  Estudio Ejemplo ', '2026-10-25');
    expect(values).toEqual({
      debtor_name: 'Talleres Ejemplo S.L.',
      invoice_numbers: 'FA-2025-001 y FA-2025-002',
      total: formatEUR(263_250),
      deadline: '04/11/2026',
      sender_name: 'Estudio Ejemplo',
      demand_date: undefined,
    });
    expect(PAYMENT_DEADLINE_DAYS).toBe(10);
  });

  it('does not invent a sender or a demand date', () => {
    const values = templateValues(claim, '   ', '2026-10-25');
    expect(values.sender_name).toBeUndefined();
    expect(values.demand_date).toBeUndefined();
  });

  it('uses the date of the latest demand, whatever the order', () => {
    const values = templateValues(
      {
        ...claim,
        events: [
          claimEvent({
            id: 'a',
            kind: 'DEMAND_SENT',
            occurred_on: '2026-09-10',
          }),
          claimEvent({
            id: 'b',
            kind: 'BUROFAX_SENT',
            occurred_on: '2026-10-01',
          }),
          claimEvent({
            id: 'c',
            kind: 'DEMAND_SENT',
            occurred_on: '2026-09-01',
          }),
        ],
      },
      null,
      '2026-10-25',
    );
    expect(values.demand_date).toBe('10/09/2026');
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-25', 10, '2026-11-04'],
    ['2026-12-25', 10, '2027-01-04'],
    ['2028-02-25', 5, '2028-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
  ])('%s + %i days is %s', (from, days, to) => {
    expect(addDays(from, days)).toBe(to);
  });
});
