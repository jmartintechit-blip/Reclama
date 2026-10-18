import { describe, expect, it } from 'vitest';
import type { DebtorKind } from './claim.ts';
import { addDays, type ISODate } from './dates.ts';
import {
  DEFAULT_ESCALATION_WAITS,
  nextAction,
  type EscalationClaim,
  type EscalationEvent,
  type NextActionInput,
  type StepEventKind,
} from './escalation.ts';

const date = (text: string) => text as ISODate;
const TODAY = date('2026-10-30');

const ev = (kind: EscalationEvent['kind'], on: string): EscalationEvent => ({
  kind,
  occurred_on: date(on),
});

// A claim whose only invoice fell due on `dueDate`: the interest, and so the first segment,
// starts the day after.
const claimDueOn = (...dueDates: string[]): EscalationClaim => ({
  lines: dueDates.map((dueDate) => ({
    segments: [{ start: addDays(date(dueDate), 1) }],
  })),
});

const run = (overrides: Partial<NextActionInput> = {}) =>
  nextAction({
    today: TODAY,
    claim: claimDueOn('2026-09-30'),
    events: [],
    debtorKind: 'BUSINESS',
    ...overrides,
  });

// `days` days before TODAY.
const daysAgo = (days: number) => addDays(TODAY, -days);

describe('nextAction: no step recorded', () => {
  it('suggests an optional friendly reminder, right away', () => {
    const result = run();

    expect(result).toMatchObject({
      action: 'SEND_REMINDER',
      earliest_on: TODAY,
      wait_days: 0,
      warnings: [],
    });
    expect(result.reason).toContain('opcional');
  });

  it('ignores NOTE events', () => {
    expect(run({ events: [ev('NOTE', '2026-10-20')] })).toEqual(run());
  });
});

describe('nextAction: every transition', () => {
  it.each([
    ['REMINDER_SENT', 'SEND_DEMAND', DEFAULT_ESCALATION_WAITS.demandDays],
    ['DEMAND_SENT', 'SEND_BUROFAX', DEFAULT_ESCALATION_WAITS.burofaxDays],
    ['BUROFAX_SENT', 'FILE_MONITORIO', DEFAULT_ESCALATION_WAITS.monitorioDays],
  ] as const)('%s -> %s, %i days later', (kind, action, wait) => {
    const result = run({ events: [ev(kind, '2026-10-20')] });

    expect(result).toMatchObject({
      action,
      wait_days: wait,
      earliest_on: addDays(date('2026-10-20'), wait),
      warnings: [],
    });
  });

  it('has the default waits the engine documents', () => {
    expect(DEFAULT_ESCALATION_WAITS).toEqual({
      demandDays: 7,
      burofaxDays: 10,
      monitorioDays: 10,
    });
  });

  it('MONITORIO_FILED -> DONE: filed, follow the court', () => {
    const result = run({ events: [ev('MONITORIO_FILED', '2026-10-25')] });

    expect(result).toMatchObject({
      action: 'DONE',
      earliest_on: null,
      wait_days: 0,
    });
    expect(result.reason).toContain('25/10/2026');
    expect(result.reason).toContain('juzgado');
  });

  it('PAID -> DONE: marked as paid', () => {
    const result = run({ events: [ev('PAID', '2026-10-25')] });

    expect(result).toMatchObject({
      action: 'DONE',
      earliest_on: null,
      wait_days: 0,
    });
    expect(result.reason).toContain('pagada');
  });
});

describe('nextAction: the wait is counted in whole days from the last step', () => {
  it.each([
    ['REMINDER_SENT', DEFAULT_ESCALATION_WAITS.demandDays],
    ['DEMAND_SENT', DEFAULT_ESCALATION_WAITS.burofaxDays],
    ['BUROFAX_SENT', DEFAULT_ESCALATION_WAITS.monitorioDays],
  ] as const)(
    'after %s: one day short is too early, the day itself and later are not',
    (kind, wait) => {
      const at = (elapsed: number) =>
        run({ events: [ev(kind, daysAgo(elapsed))] });

      const early = at(wait - 1);
      const exact = at(wait);
      const late = at(wait + 1);

      // The action never changes: the engine always names the next step.
      expect(exact.action).toBe(early.action);
      expect(late.action).toBe(early.action);
      expect(early.reason).toMatch(/^Aún es pronto/);
      expect(exact.reason).toMatch(/^Ya puedes/);
      expect(late.reason).toMatch(/^Ya puedes/);
      // `earliest_on` is the first day it is suggested: tomorrow, today, and the past.
      expect(early.earliest_on).toBe(addDays(TODAY, 1));
      expect(exact.earliest_on).toBe(TODAY);
      expect(late.earliest_on).toBe(addDays(TODAY, -1));
    },
  );

  it('says in every reason that the wait is a guideline and not a legal deadline', () => {
    for (const elapsed of [0, 100]) {
      for (const kind of [
        'REMINDER_SENT',
        'DEMAND_SENT',
        'BUROFAX_SENT',
      ] as const) {
        const { reason } = run({ events: [ev(kind, daysAgo(elapsed))] });
        expect(reason).toContain('no es un plazo legal');
      }
    }
  });

  it('a step recorded today waits the whole time', () => {
    const result = run({ events: [ev('REMINDER_SENT', TODAY)] });

    expect(result.reason).toMatch(/^Aún es pronto/);
    expect(result.earliest_on).toBe(addDays(TODAY, 7));
  });

  it('uses the waits of the config, and keeps the default for the ones it leaves out', () => {
    const events = [ev('DEMAND_SENT', '2026-10-20')];

    const custom = run({ events, config: { burofaxDays: 3 } });
    const other = run({
      events: [ev('REMINDER_SENT', '2026-10-20')],
      config: { burofaxDays: 3 },
    });

    expect(custom).toMatchObject({ wait_days: 3, earliest_on: '2026-10-23' });
    expect(custom.reason).toMatch(/^Ya puedes/);
    expect(other.wait_days).toBe(7);
  });

  it('a wait of zero days is ready at once', () => {
    const result = run({
      events: [ev('REMINDER_SENT', TODAY)],
      config: { demandDays: 0 },
    });

    expect(result.reason).toMatch(/^Ya puedes/);
    expect(result.earliest_on).toBe(TODAY);
  });
});

describe('nextAction: steps can be skipped and the most advanced one decides', () => {
  it.each([
    ['DEMAND_SENT', 'SEND_BUROFAX'],
    ['BUROFAX_SENT', 'FILE_MONITORIO'],
    ['MONITORIO_FILED', 'DONE'],
  ] as const)('%s without the earlier steps -> %s', (kind, action) => {
    expect(run({ events: [ev(kind, '2026-10-20')] }).action).toBe(action);
  });

  const everyOrder = (events: EscalationEvent[]): EscalationEvent[][] =>
    events.length <= 1
      ? [events]
      : events.flatMap((first, i) =>
          everyOrder(events.filter((_, j) => j !== i)).map((rest) => [
            first,
            ...rest,
          ]),
        );

  it('an earlier step recorded later does not take the ladder back', () => {
    // The reminder is the most recent event, but the demand was already sent.
    const events = [
      ev('DEMAND_SENT', '2026-10-01'),
      ev('REMINDER_SENT', '2026-10-29'),
    ];

    for (const order of everyOrder(events)) {
      expect(run({ events: order })).toMatchObject({
        action: 'SEND_BUROFAX',
        earliest_on: '2026-10-11', // counted from the demand, not from the reminder
      });
    }
  });

  it('the whole ladder in any order ends at the monitorio', () => {
    const events = [
      ev('REMINDER_SENT', '2026-10-01'),
      ev('DEMAND_SENT', '2026-10-05'),
      ev('BUROFAX_SENT', '2026-10-12'),
      ev('MONITORIO_FILED', '2026-10-25'),
    ];

    for (const order of everyOrder(events)) {
      expect(run({ events: order }).action).toBe('DONE');
    }
  });

  it('counts from the LATEST date of the most advanced step, in any order', () => {
    const events = [
      ev('DEMAND_SENT', '2026-10-01'),
      ev('DEMAND_SENT', '2026-10-20'),
      ev('DEMAND_SENT', '2026-10-10'),
    ];

    for (const order of everyOrder(events)) {
      expect(run({ events: order })).toMatchObject({
        action: 'SEND_BUROFAX',
        earliest_on: '2026-10-30',
      });
    }
  });

  it('events of the same day: the more advanced step wins whatever the order', () => {
    const events = [
      ev('REMINDER_SENT', '2026-10-20'),
      ev('DEMAND_SENT', '2026-10-20'),
    ];

    for (const order of everyOrder(events)) {
      expect(run({ events: order })).toMatchObject({
        action: 'SEND_BUROFAX',
        earliest_on: '2026-10-30',
      });
    }
  });

  it('two events of the same kind and day count once', () => {
    const events = [
      ev('REMINDER_SENT', '2026-10-20'),
      ev('REMINDER_SENT', '2026-10-20'),
    ];

    expect(run({ events })).toMatchObject({
      action: 'SEND_DEMAND',
      earliest_on: '2026-10-27',
    });
  });

  it('NOTE events change nothing, not even after the last step', () => {
    const events = [
      ev('DEMAND_SENT', '2026-10-20'),
      ev('NOTE', '2026-10-29'),
      ev('NOTE', '2026-10-01'),
    ];

    expect(run({ events })).toEqual(
      run({ events: [ev('DEMAND_SENT', '2026-10-20')] }),
    );
  });
});

describe('nextAction: paid', () => {
  it.each([
    'REMINDER_SENT',
    'DEMAND_SENT',
    'BUROFAX_SENT',
    'MONITORIO_FILED',
  ] as const)('PAID after %s, in either order, is DONE', (kind) => {
    const events = [ev(kind, '2026-10-10'), ev('PAID', '2026-10-20')];

    expect(run({ events }).reason).toContain('pagada');
    expect(run({ events: [...events].reverse() }).reason).toContain('pagada');
  });

  it('is DONE whatever the debtor kind and the age of the debt', () => {
    const result = run({
      events: [ev('PAID', '2026-10-20')],
      debtorKind: 'CONSUMER',
      claim: claimDueOn('2015-01-01'),
    });

    expect(result).toMatchObject({ action: 'DONE', warnings: [] });
  });
});

describe('nextAction: debtor kind', () => {
  it.each(['CONSUMER', 'PUBLIC_ADMIN', 'UNKNOWN'] as const)(
    '%s is BLOCKED, with or without events',
    (debtorKind: DebtorKind) => {
      const withEvents = [
        'REMINDER_SENT',
        'DEMAND_SENT',
        'MONITORIO_FILED',
      ].map((kind) =>
        run({
          debtorKind,
          events: [ev(kind as StepEventKind, '2026-10-01')],
        }),
      );

      for (const result of [run({ debtorKind }), ...withEvents]) {
        expect(result).toMatchObject({
          action: 'BLOCKED',
          earliest_on: null,
          wait_days: 0,
          warnings: [],
        });
        expect(result.reason.length).toBeGreaterThan(20);
      }
    },
  );

  it('gives each kind its own reason, and does not say the public administration is outside the law', () => {
    const reasons = (['CONSUMER', 'PUBLIC_ADMIN', 'UNKNOWN'] as const).map(
      (debtorKind) => run({ debtorKind }).reason,
    );

    expect(new Set(reasons).size).toBe(3);
    expect(reasons[0]).toContain('consumidor');
    expect(reasons[1]).toContain('administración pública');
    expect(reasons[1]).not.toMatch(/fuera de la Ley/);
    expect(reasons[2]).toContain('Confírmalo');
  });

  it('BUSINESS is the only kind that is not blocked', () => {
    expect(run({ debtorKind: 'BUSINESS' }).action).toBe('SEND_REMINDER');
  });
});

describe('nextAction: possible limitation of the claim', () => {
  // Today is 2026-10-18 here: four and a half years before is 2022-04-18.
  const at = (dueDates: string[], extra: Partial<NextActionInput> = {}) =>
    run({
      today: date('2026-10-18'),
      claim: claimDueOn(...dueDates),
      ...extra,
    });

  it('does not warn on the exact day four and a half years back, and warns the day before', () => {
    expect(at(['2022-04-18']).warnings).toEqual([]);
    expect(at(['2022-04-19']).warnings).toEqual([]);

    const [warning, ...rest] = at(['2022-04-17']).warnings;
    expect(rest).toEqual([]);
    expect(warning?.code).toBe('POSSIBLE_LIMITATION');
    expect(warning?.message).toContain('17/04/2022');
    expect(warning?.message).toContain('1964');
    expect(warning?.message).toContain('abogado');
  });

  it('the oldest due date of all the lines decides', () => {
    expect(
      at(['2026-09-01', '2022-04-17', '2025-01-01']).warnings,
    ).toHaveLength(1);
    expect(at(['2026-09-01', '2022-04-18', '2025-01-01']).warnings).toEqual([]);
  });

  it('a day that does not exist four and a half years back counts as the last day of that month', () => {
    // 31 Aug 2026 minus 54 months: February 2022 has 28 days.
    const base = { today: date('2026-08-31') };

    expect(run({ ...base, claim: claimDueOn('2022-02-28') }).warnings).toEqual(
      [],
    );
    expect(
      run({ ...base, claim: claimDueOn('2022-02-27') }).warnings,
    ).toHaveLength(1);
  });

  it('warns on every pending action, and on none of the others', () => {
    const old = claimDueOn('2019-01-01');
    const pending = [
      [],
      [ev('REMINDER_SENT', '2026-10-01')],
      [ev('DEMAND_SENT', '2026-10-01')],
      [ev('BUROFAX_SENT', '2026-10-01')],
    ];

    for (const events of pending) {
      expect(at(['2019-01-01'], { events, claim: old }).warnings).toHaveLength(
        1,
      );
    }
    for (const events of [
      [ev('MONITORIO_FILED', '2026-10-01')],
      [ev('PAID', '2026-10-01')],
    ]) {
      expect(at(['2019-01-01'], { events }).warnings).toEqual([]);
    }
    expect(at(['2019-01-01'], { debtorKind: 'CONSUMER' }).warnings).toEqual([]);
  });

  it('has nothing to warn about when the claim has no lines or a line without segments', () => {
    expect(run({ claim: { lines: [] } }).warnings).toEqual([]);
    expect(run({ claim: { lines: [{ segments: [] }] } }).warnings).toEqual([]);
  });
});
