import { describe, expect, it } from 'vitest';
import type { Interest, Payment } from './api-types.ts';
import { buildTimeline } from './timeline.ts';
import { ESTIMATED_DUE_NOTE, interestToTimeline } from './invoice-timeline.ts';

const NBSP = ' ';

function seg(
  start: string,
  end: string,
  days: number,
  rate_bp: number,
  balance_cents: number,
  interest_cents: number,
) {
  return {
    start,
    end,
    days,
    year_days: 365,
    rate_bp,
    balance_cents,
    interest_cents,
  };
}

// What GET /api/invoices/:id/interest answered (fictitious demo invoice, 500 EUR paid on
// 2026-04-15): four segments, a semester start without a rate change and a rate change.
const WITH_PAYMENT: Interest = {
  invoice_id: '2b9df557-69f0-4aa3-a1d3-784ea6a42b1c',
  as_of: '2026-10-19',
  principal_cents: 184_250,
  paid_cents: 50_000,
  balance_cents: 134_250,
  due_date_effective: '2025-09-16',
  due_date_estimated: false,
  interest_cents: 17_894,
  warnings: [],
  segments: [
    seg('2025-09-17', '2025-12-31', 106, 1015, 184_250, 5431),
    seg('2026-01-01', '2026-04-15', 105, 1015, 184_250, 5380),
    seg('2026-04-16', '2026-06-30', 76, 1015, 134_250, 2837),
    seg('2026-07-01', '2026-10-19', 111, 1040, 134_250, 4246),
  ],
};

const payment = (
  id: string,
  paid_on: string,
  amount_cents: number,
): Payment => ({
  id,
  invoice_id: WITH_PAYMENT.invoice_id,
  paid_on,
  amount_cents,
});

describe('interestToTimeline', () => {
  const input = interestToTimeline(WITH_PAYMENT, [
    payment('p1', '2026-04-15', 50_000),
  ]);

  it('keeps the dates and renames the segment fields', () => {
    expect(input.due).toBe('2025-09-16');
    expect(input.today).toBe('2026-10-19');
    expect(input.segments).toHaveLength(4);
    expect(input.segments[2]).toEqual({
      start: '2026-04-16',
      end: '2026-06-30',
      days: 76,
      rateBp: 1015,
      balance: 134_250,
      interest: 2837,
    });
  });

  it('marks the due date, the semester start, the rate change, the payment and the calculation date', () => {
    expect(input.events).toEqual([
      { date: '2025-09-16', label: 'Vencimiento', kind: 'due' },
      { date: '2026-01-01', label: 'Nuevo semestre', kind: 'milestone' },
      {
        date: '2026-07-01',
        label: 'Cambia el tipo',
        kind: 'milestone',
        extra: `10,15${NBSP}% a 10,40${NBSP}%`,
      },
      {
        date: '2026-04-15',
        label: 'Cobro',
        kind: 'payment',
        extra: `500,00${NBSP}€`,
      },
      { date: '2026-10-19', label: 'Fecha de cálculo', kind: 'today' },
    ]);
  });

  it('does not invent a milestone for the split a payment causes', () => {
    // 2026-04-16 starts a segment only because of the payment: the payment event says it.
    expect(input.events.some((e) => e.date === '2026-04-16')).toBe(false);
  });

  it('feeds the Timeline model: the list interleaves segments and events by date', () => {
    const model = buildTimeline(input);
    expect(model.totalInterest).toBe(17_894);
    expect(
      model.items.map((item) =>
        item.type === 'event' ? item.event.label : item.segment.start,
      ),
    ).toEqual([
      'Vencimiento',
      '2025-09-17',
      'Nuevo semestre',
      '2026-01-01',
      'Cobro',
      '2026-04-16',
      'Cambia el tipo',
      '2026-07-01',
      'Fecha de cálculo',
    ]);
  });

  it('says when the due date is an estimate', () => {
    const estimated = interestToTimeline(
      { ...WITH_PAYMENT, due_date_estimated: true },
      [],
    );
    expect(estimated.events[0]).toEqual({
      date: '2025-09-16',
      label: 'Vencimiento',
      kind: 'due',
      extra: ESTIMATED_DUE_NOTE,
    });
    expect(ESTIMATED_DUE_NOTE).toBe('estimado: 30 días desde la emisión');
  });

  it('adds payments made on the same day into one event', () => {
    const merged = interestToTimeline(WITH_PAYMENT, [
      payment('a', '2026-04-15', 20_000),
      payment('b', '2026-04-15', 30_000),
    ]);
    expect(merged.events.filter((e) => e.kind === 'payment')).toEqual([
      {
        date: '2026-04-15',
        label: 'Cobro',
        kind: 'payment',
        extra: `500,00${NBSP}€`,
      },
    ]);
  });

  it('leaves out payments before the due date and after the calculation date', () => {
    const outside = interestToTimeline(WITH_PAYMENT, [
      payment('early', '2025-08-20', 1000),
      payment('late', '2026-12-01', 1000),
    ]);
    expect(outside.events.some((e) => e.kind === 'payment')).toBe(false);
  });

  it('names a semester start at 1 July when the rate stays the same', () => {
    const flat = interestToTimeline(
      {
        ...WITH_PAYMENT,
        segments: [
          seg('2026-01-01', '2026-06-30', 181, 1015, 100_000, 5000),
          seg('2026-07-01', '2026-10-19', 111, 1015, 100_000, 3000),
        ],
      },
      [],
    );
    expect(flat.events.map((e) => e.label)).toEqual([
      'Vencimiento',
      'Nuevo semestre',
      'Fecha de cálculo',
    ]);
  });

  it('handles an invoice that is not overdue yet (no segments)', () => {
    const none = interestToTimeline(
      {
        ...WITH_PAYMENT,
        due_date_effective: '2026-11-09',
        interest_cents: 0,
        segments: [],
      },
      [],
    );
    expect(none.segments).toEqual([]);
    expect(none.events.map((e) => e.kind)).toEqual(['due', 'today']);
  });
});
