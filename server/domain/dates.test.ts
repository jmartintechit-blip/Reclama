import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInYear,
  diffDays,
  isLeapYear,
  parseISODate,
  todayMadrid,
  type Clock,
  type ISODate,
} from './dates.ts';

function date(text: string): ISODate {
  const parsed = parseISODate(text);
  if (parsed === null) throw new Error(`Bad test date ${text}`);
  return parsed;
}

const clockAt = (instant: string): Clock => ({ now: () => new Date(instant) });

describe('parseISODate', () => {
  it.each([
    '2026-10-13',
    '2024-02-29',
    '2000-02-29',
    '2026-12-31',
    '1000-01-01',
    '9999-12-31',
  ])('accepts %s', (text) => {
    expect(parseISODate(text)).toBe(text);
  });

  it.each([
    '2026-02-31',
    '2026-04-31',
    '2023-02-29',
    '1900-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '26-01-01',
    '0999-01-01',
    '2026-1-1',
    '2026/01/01',
    '13/10/2026',
    ' 2026-01-01',
    '2026-01-01 ',
    '2026-01-01T00:00:00Z',
    '',
    'hello',
  ])('rejects %j', (text) => {
    expect(parseISODate(text)).toBeNull();
  });
});

describe('leap years', () => {
  it.each([
    [1900, false],
    [2000, true],
    [2024, true],
    [2026, false],
    [2028, true],
    [2100, false],
  ])('isLeapYear(%i) is %s', (year, leap) => {
    expect(isLeapYear(year)).toBe(leap);
  });

  it('daysInYear is 366 in leap years and 365 otherwise', () => {
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2000)).toBe(366);
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(1900)).toBe(365);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-13', 0, '2026-10-13'],
    ['2026-10-13', 30, '2026-11-12'],
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-28', 2, '2024-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-01-01', 365, '2027-01-01'],
    ['2024-01-01', 366, '2025-01-01'],
    ['2026-03-28', 2, '2026-03-30'],
    ['2026-10-24', 2, '2026-10-26'],
  ])('addDays(%s, %i) is %s', (start, days, expected) => {
    expect(addDays(date(start), days)).toBe(expected);
  });

  it('rejects fractional or non-finite day counts', () => {
    expect(() => addDays(date('2026-01-01'), 0.5)).toThrow(RangeError);
    expect(() => addDays(date('2026-01-01'), NaN)).toThrow(RangeError);
  });

  it('refuses to leave years 1000-9999', () => {
    expect(() => addDays(date('9999-12-31'), 1)).toThrow(RangeError);
    expect(() => addDays(date('1000-01-01'), -1)).toThrow(RangeError);
  });
});

describe('diffDays', () => {
  it.each([
    ['2026-10-13', '2026-10-13', 0],
    ['2026-10-14', '2026-10-13', 1],
    ['2026-10-13', '2026-10-14', -1],
    ['2024-03-01', '2024-02-28', 2],
    ['2026-03-01', '2026-02-28', 1],
    ['2027-01-01', '2026-12-31', 1],
    ['2027-01-01', '2026-01-01', 365],
    ['2025-01-01', '2024-01-01', 366],
    ['2026-07-01', '2026-06-30', 1],
    // Days around the clock changes: always whole calendar days.
    ['2026-03-30', '2026-03-28', 2],
    ['2026-10-26', '2026-10-24', 2],
  ])('diffDays(%s, %s) is %i', (later, earlier, expected) => {
    expect(diffDays(date(later), date(earlier))).toBe(expected);
  });

  it('is the inverse of addDays', () => {
    const start = date('2023-11-05');
    for (const days of [-800, -366, -1, 0, 1, 59, 60, 365, 366, 1461]) {
      expect(diffDays(addDays(start, days), start)).toBe(days);
    }
  });
});

describe('todayMadrid', () => {
  it.each([
    // 31 Dec 23:30 UTC is already 1 Jan in Madrid (UTC+1).
    ['2026-12-31T23:30:00Z', '2027-01-01'],
    ['2026-12-31T22:59:59Z', '2026-12-31'],
    ['2026-12-31T23:00:00Z', '2027-01-01'],
    // Winter (UTC+1).
    ['2026-01-15T12:00:00Z', '2026-01-15'],
    ['2026-01-15T22:59:59Z', '2026-01-15'],
    ['2026-01-15T23:00:00Z', '2026-01-16'],
    // Summer (UTC+2): the day changes at 22:00 UTC.
    ['2026-06-30T21:59:59Z', '2026-06-30'],
    ['2026-06-30T22:00:00Z', '2026-07-01'],
    // Spring change, 29 Mar 2026 at 01:00 UTC: UTC+1 before, UTC+2 after.
    ['2026-03-28T23:00:00Z', '2026-03-29'],
    ['2026-03-29T21:59:59Z', '2026-03-29'],
    ['2026-03-29T22:00:00Z', '2026-03-30'],
    // Autumn change, 25 Oct 2026 at 01:00 UTC: UTC+2 before, UTC+1 after.
    ['2026-10-24T22:00:00Z', '2026-10-25'],
    ['2026-10-25T22:59:59Z', '2026-10-25'],
    ['2026-10-25T23:00:00Z', '2026-10-26'],
    // Leap day.
    ['2028-02-28T23:30:00Z', '2028-02-29'],
  ])('at %s it is %s in Madrid', (instant, expected) => {
    expect(todayMadrid(clockAt(instant))).toBe(expected);
  });
});
