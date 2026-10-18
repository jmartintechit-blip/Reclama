// The worked example on the home page: a fictitious invoice. The segments are what the interest
// engine returns for it; a test in server/domain recomputes them so they cannot drift from the
// real rates. Plain data, no DOM, so the server's type checker can read it too.
import { formatRate } from '../lib/format.ts';
import type { TimelineEvent, TimelineSegment } from '../lib/timeline.ts';

export const EXAMPLE_PRINCIPAL_CENTS = 894_000;
export const EXAMPLE_COMPENSATION_CENTS = 4_000;
export const EXAMPLE_ISSUE_DATE = '2025-08-13';
export const EXAMPLE_DUE_DATE = '2025-09-12';
// Frozen on purpose: the page is static, so the example is "as of" a fixed day.
export const EXAMPLE_AS_OF = '2026-10-19';

export const EXAMPLE_SEGMENTS: readonly TimelineSegment[] = [
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
    end: '2026-06-30',
    days: 181,
    rateBp: 1015,
    balance: 894_000,
    interest: 44_998,
  },
  {
    start: '2026-07-01',
    end: '2026-10-19',
    days: 111,
    rateBp: 1040,
    balance: 894_000,
    interest: 28_275,
  },
];

export const EXAMPLE_EVENTS: readonly TimelineEvent[] = [
  { date: '2025-09-12', label: 'Vence', kind: 'due' },
  { date: '2026-01-01', label: 'Nuevo semestre', kind: 'milestone' },
  {
    date: '2026-07-01',
    label: 'Cambia el tipo',
    kind: 'milestone',
    extra: `${formatRate(1015)} a ${formatRate(1040)}`,
  },
  { date: '2026-10-19', label: 'Fecha de cálculo', kind: 'today' },
];
