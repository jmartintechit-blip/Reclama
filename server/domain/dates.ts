// Calendar dates without time zones. A date is a string `YYYY-MM-DD`; arithmetic goes through
// an integer "day number" counted in UTC, so daylight saving time cannot move a date.

declare const isoDateBrand: unique symbol;
export type ISODate = string & { readonly [isoDateBrand]: true };

// Time always enters the domain through this, so tests can fix "now".
export interface Clock {
  now(): Date;
}

const MS_PER_DAY = 86_400_000;
// Years 1000-9999 only: Date.UTC treats years 0-99 as 1900-1999.
const ISO_DATE = /^([1-9]\d{3})-(\d{2})-(\d{2})$/;

// Whole days since 1970-01-01. Date.UTC rolls over invalid days (31 Feb -> 3 Mar).
function toDayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function dayNumberOf(date: ISODate): number {
  return toDayNumber(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    Number(date.slice(8, 10)),
  );
}

function toISOString(dayNumber: number): string {
  const d = new Date(dayNumber * MS_PER_DAY);
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Strict: only a real calendar date in the exact format, no spaces. Returns null otherwise.
export function parseISODate(text: string): ISODate | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const [, year, month, day] = match;
  // If the day rolled over, the rebuilt string differs from the input.
  const rebuilt = toISOString(
    toDayNumber(Number(year), Number(month), Number(day)),
  );
  return rebuilt === text ? (text as ISODate) : null;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInYear(year: number): 365 | 366 {
  return isLeapYear(year) ? 366 : 365;
}

export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`Days must be a safe integer, got ${String(days)}`);
  }
  const result = parseISODate(toISOString(dayNumberOf(date) + days));
  if (result === null) {
    throw new RangeError(
      `${date} plus ${String(days)} days is outside years 1000-9999`,
    );
  }
  return result;
}

// Calendar days from `earlier` to `later`: diffDays('2024-03-01', '2024-02-28') is 2.
export function diffDays(later: ISODate, earlier: ISODate): number {
  return dayNumberOf(later) - dayNumberOf(earlier);
}

const MADRID_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The date on the wall calendar in Madrid, not in UTC: 31 Dec 23:30 UTC is already 1 Jan there.
export function todayMadrid(clock: Clock): ISODate {
  const parts = MADRID_DAY.formatToParts(clock.now());
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const date = parseISODate(`${part('year')}-${part('month')}-${part('day')}`);
  if (date === null)
    throw new Error('Could not read the date in Europe/Madrid');
  return date;
}
