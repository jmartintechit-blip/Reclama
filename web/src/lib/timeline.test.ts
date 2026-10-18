import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_AS_OF,
  EXAMPLE_DUE_DATE,
  EXAMPLE_EVENTS,
  EXAMPLE_SEGMENTS,
} from '../content/example.ts';
import {
  buildTimeline,
  type TimelineEvent,
  type TimelineInput,
  type TimelineSegment,
} from './timeline.ts';

const NBSP = ' ';

const plain: TimelineInput = {
  due: EXAMPLE_DUE_DATE,
  today: EXAMPLE_AS_OF,
  segments: EXAMPLE_SEGMENTS,
  events: EXAMPLE_EVENTS,
};

// The same invoice after a partial payment of 2.000,00 EUR on 2026-04-15.
const paidSegments: TimelineSegment[] = [
  {
    start: '2025-09-13',
    end: '2025-12-31',
    days: 110,
    rateBp: 1015,
    balance: 894_000,
    interest: 27_347,
  },
  {
    start: '2026-01-01',
    end: '2026-04-15',
    days: 105,
    rateBp: 1015,
    balance: 894_000,
    interest: 26_104,
  },
  {
    start: '2026-04-16',
    end: '2026-06-30',
    days: 76,
    rateBp: 1015,
    balance: 694_000,
    interest: 14_667,
  },
  {
    start: '2026-07-01',
    end: '2026-10-19',
    days: 111,
    rateBp: 1040,
    balance: 694_000,
    interest: 21_949,
  },
];
const paidEvents: TimelineEvent[] = [
  { date: '2026-10-19', label: 'Hoy', kind: 'today' },
  { date: '2026-04-15', label: 'Cobro', kind: 'payment', extra: '2.000,00 €' },
  { date: '2025-09-12', label: 'Vence', kind: 'due' },
  { date: '2026-07-01', label: 'Cambia el tipo', kind: 'milestone' },
  { date: '2026-01-01', label: 'Nuevo semestre', kind: 'milestone' },
];
const paid: TimelineInput = {
  ...plain,
  segments: paidSegments,
  events: paidEvents, // deliberately out of order
};

const sequence = (input: TimelineInput) =>
  buildTimeline(input).items.map((item) =>
    item.type === 'event' ? item.event.label : item.segment.start,
  );

describe('buildTimeline: the example without payments', () => {
  const model = buildTimeline(plain);

  it('adds up the real numbers of the example', () => {
    expect(model.totalDays).toBe(402);
    expect(model.totalInterest).toBe(100_620);
    expect(EXAMPLE_SEGMENTS.map((s) => s.interest)).toEqual([
      27_347, 44_998, 28_275,
    ]);
    expect(EXAMPLE_SEGMENTS.map((s) => s.days)).toEqual([110, 181, 111]);
  });

  it('puts the due date at 0 and today at 100', () => {
    const [due, , , today] = model.marks;
    expect(due?.position).toBe(0);
    expect(due?.align).toBe('start');
    expect(today?.position).toBe(100);
    expect(today?.align).toBe('end');
  });

  it('places a milestone in proportion to the days elapsed', () => {
    const semester = model.marks.find((m) => m.event.date === '2026-01-01');
    const rate = model.marks.find((m) => m.event.date === '2026-07-01');
    expect(semester?.position).toBe(27.61); // 111 / 402
    expect(semester?.align).toBe('center');
    expect(rate?.position).toBe(72.64); // 292 / 402
  });

  it('marks the due date and today as key lines only', () => {
    expect(model.marks.map((m) => m.key)).toEqual([true, false, false, true]);
  });

  it('draws the cumulative curve from 0 to the total', () => {
    expect(model.curvePath).toBe('M0 100 L27.36 72.82 L72.39 28.1 L100 0');
    expect(model.areaPath).toBe(`${model.curvePath} L100 100 L0 100 Z`);
  });

  it('makes the cumulative amounts add up to the sum of the segments', () => {
    const segments = model.items.flatMap((i) =>
      i.type === 'segment' ? [i] : [],
    );
    expect(segments.map((s) => s.cumulative)).toEqual([
      27_347, 72_345, 100_620,
    ]);
    expect(segments.at(-1)?.cumulative).toBe(
      EXAMPLE_SEGMENTS.reduce((sum, s) => sum + s.interest, 0),
    );
  });

  it('sizes the columns by days and the bars by share and balance', () => {
    expect(model.columns).toBe('110fr 181fr 111fr');
    const shares = model.items.flatMap((i) =>
      i.type === 'segment' ? [i.share] : [],
    );
    expect(shares).toEqual([0.2736, 0.4502, 0.2761]);
    const ratios = model.items.flatMap((i) =>
      i.type === 'segment' ? [i.balanceRatio] : [],
    );
    expect(ratios).toEqual([1, 1, 1]);
  });

  it('lists milestones and segments in date order', () => {
    expect(sequence(plain)).toEqual([
      'Vence',
      '2025-09-13',
      'Nuevo semestre',
      '2026-01-01',
      'Cambia el tipo',
      '2026-07-01',
      'Fecha de cálculo',
    ]);
  });

  it('carries the rate change text with non-breaking spaces', () => {
    const change = EXAMPLE_EVENTS.find((e) => e.label === 'Cambia el tipo');
    expect(change?.extra).toBe(`10,15${NBSP}% a 10,40${NBSP}%`);
  });
});

describe('buildTimeline: with a partial payment', () => {
  const model = buildTimeline(paid);

  it('keeps the total equal to the sum of the four segments', () => {
    expect(model.totalInterest).toBe(90_067);
    expect(model.curvePath).toBe(
      'M0 100 L27.36 69.64 L53.48 40.65 L72.39 24.37 L100 0',
    );
  });

  it('thins the bar after the payment', () => {
    const ratios = model.items.flatMap((i) =>
      i.type === 'segment' ? [i.balanceRatio] : [],
    );
    expect(ratios).toEqual([1, 1, 0.776, 0.776]);
  });

  it('sorts events and puts the payment right after the segment that ends on its day', () => {
    expect(sequence(paid)).toEqual([
      'Vence',
      '2025-09-13',
      'Nuevo semestre', // on the first day of the next segment: goes before it
      '2026-01-01',
      'Cobro', // on the last day of its segment: goes right after it
      '2026-04-16',
      'Cambia el tipo',
      '2026-07-01',
      'Hoy',
    ]);
    expect(model.marks.map((m) => m.event.label)).toEqual([
      'Vence',
      'Nuevo semestre',
      'Cobro',
      'Cambia el tipo',
      'Hoy',
    ]);
  });

  it('does not move the payment when it falls on the first day of a segment', () => {
    const lateEvents: TimelineEvent[] = [
      ...paidEvents.filter((e) => e.kind !== 'payment'),
      { date: '2026-04-16', label: 'Cobro', kind: 'payment' },
    ];
    const order = sequence({ ...paid, events: lateEvents });
    expect(order.indexOf('Cobro')).toBeLessThan(order.indexOf('2026-04-16'));
    expect(order.indexOf('Cobro')).toBeGreaterThan(order.indexOf('2026-01-01'));
  });
});

describe('buildTimeline: edge cases', () => {
  it('clamps an event outside the range', () => {
    const model = buildTimeline({
      ...plain,
      events: [
        { date: '2025-01-01', label: 'Antes', kind: 'milestone' },
        { date: '2027-01-01', label: 'Después', kind: 'milestone' },
      ],
    });
    expect(model.marks.map((m) => m.position)).toEqual([0, 100]);
  });

  it('does not divide by zero without segments or days', () => {
    const empty = buildTimeline({
      due: '2026-10-19',
      today: '2026-10-19',
      segments: [],
      events: [{ date: '2026-10-19', label: 'Vence', kind: 'due' }],
    });
    expect(empty.totalDays).toBe(0);
    expect(empty.totalInterest).toBe(0);
    expect(empty.curvePath).toBe('M0 100');
    expect(empty.columns).toBe('');
    expect(empty.items).toHaveLength(1);
  });

  it('rejects a date that is not ISO', () => {
    expect(() => buildTimeline({ ...plain, due: '12/09/2025' })).toThrow(
      RangeError,
    );
  });
});
