// Turns the interest endpoint's answer, plus the payments of the invoice, into the input of the
// Timeline: one segment per API segment and the milestones of the debt. Pure: no DOM, no clock.
import { formatEUR, formatRate } from './format.ts';
import type { Interest, Payment } from './api-types.ts';
import type {
  TimelineEvent,
  TimelineInput,
  TimelineSegment,
} from './timeline.ts';

export const ESTIMATED_DUE_NOTE = 'estimado: 30 días desde la emisión';

// The engine starts a new segment at every semester (1 January, 1 July), at every rate change and
// the day after a payment. A boundary that is none of the first two is a payment, which the
// payment event already shows.
function isSemesterStart(iso: string): boolean {
  return iso.endsWith('-01-01') || iso.endsWith('-07-01');
}

export function interestToTimeline(
  interest: Interest,
  payments: readonly Payment[],
): TimelineInput {
  const due = interest.due_date_effective;
  const segments: TimelineSegment[] = interest.segments.map((s) => ({
    start: s.start,
    end: s.end,
    days: s.days,
    rateBp: s.rate_bp,
    balance: s.balance_cents,
    interest: s.interest_cents,
  }));

  const events: TimelineEvent[] = [
    {
      date: due,
      label: 'Vencimiento',
      kind: 'due',
      ...(interest.due_date_estimated ? { extra: ESTIMATED_DUE_NOTE } : {}),
    },
  ];

  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1];
    const after = segments[i];
    if (!before || !after) continue;
    if (before.rateBp !== after.rateBp) {
      events.push({
        date: after.start,
        label: 'Cambia el tipo',
        kind: 'milestone',
        extra: `${formatRate(before.rateBp)} a ${formatRate(after.rateBp)}`,
      });
    } else if (isSemesterStart(after.start)) {
      events.push({
        date: after.start,
        label: 'Nuevo semestre',
        kind: 'milestone',
      });
    }
  }

  // Payments on the same day are one milestone (two marks on the same spot could not be read).
  // Those before the due date or after the calculation date are outside the drawn period.
  const byDay = new Map<string, number>();
  for (const payment of payments) {
    if (payment.paid_on < due || payment.paid_on > interest.as_of) continue;
    byDay.set(
      payment.paid_on,
      (byDay.get(payment.paid_on) ?? 0) + payment.amount_cents,
    );
  }
  for (const [date, cents] of byDay) {
    events.push({
      date,
      label: 'Cobro',
      kind: 'payment',
      extra: formatEUR(cents),
    });
  }

  events.push({
    date: interest.as_of,
    label: 'Fecha de cálculo',
    kind: 'today',
  });

  return { due, today: interest.as_of, segments, events };
}
