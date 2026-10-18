// Turns the interest engine's segments and the milestones of a debt into everything the
// Timeline needs to draw: positions on the axis, the cumulative-interest curve and the ordered
// list. Pure: no DOM, no clock ("today" is an argument).
export interface TimelineSegment {
  start: string; // ISO date, inclusive
  end: string; // ISO date, inclusive
  days: number;
  rateBp: number;
  balance: number; // cents outstanding during the whole segment
  interest: number; // cents, already rounded
}

export type TimelineEventKind = 'due' | 'milestone' | 'payment' | 'today';

export interface TimelineEvent {
  date: string; // ISO date
  label: string;
  kind: TimelineEventKind;
  extra?: string; // already formatted text, for example "2.000,00 €"
}

export interface TimelineInput {
  due: string;
  today: string;
  segments: readonly TimelineSegment[];
  events: readonly TimelineEvent[];
}

export interface TimelineMark {
  event: TimelineEvent;
  position: number; // 0 (due date) to 100 (today), in percent of the axis
  align: 'start' | 'center' | 'end'; // keeps labels near the edges inside the box
  key: boolean; // due date and today get a solid guide line
}

export type TimelineItem =
  | { type: 'event'; id: string; event: TimelineEvent }
  | {
      type: 'segment';
      id: string;
      segment: TimelineSegment;
      alt: boolean; // alternate shade so adjacent segments can be told apart
      share: number; // days of the segment / days of the whole debt
      balanceRatio: number; // balance / highest balance: the bar thickness
      cumulative: number; // interest up to and including this segment, in cents
    };

export interface TimelineModel {
  totalDays: number;
  totalInterest: number;
  curvePath: string; // SVG path in a 100 x 100 box
  areaPath: string;
  marks: TimelineMark[];
  items: TimelineItem[];
  columns: string; // grid-template-columns: one proportional column per segment
}

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS
  );
}

// Geometry only (never money): the ban on toFixed is for amounts.
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export function buildTimeline(input: TimelineInput): TimelineModel {
  const { due, today, segments } = input;
  const dueDay = dayNumber(due);
  const totalDays = dayNumber(today) - dueDay;
  // Avoids dividing by zero when "today" is the due date; nothing is drawn then anyway.
  const span = Math.max(totalDays, 1);
  const position = (iso: string): number =>
    round(
      Math.min(100, Math.max(0, ((dayNumber(iso) - dueDay) / span) * 100)),
      2,
    );

  const cumulatives: number[] = [];
  let running = 0;
  for (const segment of segments) {
    running += segment.interest;
    cumulatives.push(running);
  }
  const totalInterest = running;
  const topBalance = Math.max(1, ...segments.map((s) => s.balance));

  // The curve starts at the due date with nothing accrued and rises at the end of each segment.
  const points: [number, number][] = [[0, 100]];
  segments.forEach((segment, index) => {
    const accrued = cumulatives[index] ?? 0;
    const y = totalInterest === 0 ? 100 : 100 - (accrued / totalInterest) * 100;
    points.push([position(segment.end), round(y, 2)]);
  });
  const curvePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${String(x)} ${String(y)}`)
    .join(' ');

  const sorted = [...input.events].sort(
    (a, b) => dayNumber(a.date) - dayNumber(b.date),
  );

  const marks = sorted.map((event): TimelineMark => {
    const at = position(event.date);
    return {
      event,
      position: at,
      align: at < 6 ? 'start' : at > 94 ? 'end' : 'center',
      key: event.kind === 'due' || event.kind === 'today',
    };
  });

  // The vertical list interleaves milestones and segments by date. A milestone that falls on or
  // before a segment's first day goes before it; a payment on a segment's last day goes right
  // after it (the balance changes the next day, which is where the next segment starts).
  const items: TimelineItem[] = [];
  let next = 0;
  const takeEvents = (accept: (event: TimelineEvent) => boolean): void => {
    for (
      let event = sorted[next];
      event && accept(event);
      event = sorted[next]
    ) {
      items.push({ type: 'event', id: `event-${String(items.length)}`, event });
      next++;
    }
  };
  segments.forEach((segment, index) => {
    takeEvents((event) => dayNumber(event.date) <= dayNumber(segment.start));
    items.push({
      type: 'segment',
      id: `segment-${String(index)}`,
      segment,
      alt: index % 2 === 1,
      share: round(segment.days / span, 4),
      balanceRatio: round(segment.balance / topBalance, 3),
      cumulative: cumulatives[index] ?? 0,
    });
    takeEvents(
      (event) =>
        event.kind === 'payment' &&
        dayNumber(event.date) <= dayNumber(segment.end),
    );
  });
  takeEvents(() => true);

  return {
    totalDays,
    totalInterest,
    curvePath,
    areaPath: `${curvePath} L100 100 L0 100 Z`,
    marks,
    items,
    columns: segments.map((s) => `${String(s.days)}fr`).join(' '),
  };
}
