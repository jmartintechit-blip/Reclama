// Calendar helpers on ISO dates (YYYY-MM-DD). The server counts days in Madrid time, so "today"
// is Madrid's too, whatever time zone the browser is in.

const madrid = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// en-CA formats as YYYY-MM-DD.
export function todayMadrid(now: Date = new Date()): string {
  return madrid.format(now);
}

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS
  );
}

// Whole days from `from` to `to` (negative when `to` is earlier).
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

// `iso` moved by whole calendar days (negative: back).
export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}
