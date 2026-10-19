import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatDate,
  formatDays,
  formatEUR,
  formatRate,
} from './format.ts';

const NBSP = ' ';

describe('formatEUR', () => {
  it('keeps the thousands dot on four-digit amounts', () => {
    expect(formatEUR(894_000)).toBe(`8.940,00${NBSP}€`);
    expect(formatEUR(998_620)).toBe(`9.986,20${NBSP}€`);
    expect(formatEUR(100_620)).toBe(`1.006,20${NBSP}€`);
  });

  it('groups larger amounts and pads the decimals', () => {
    expect(formatEUR(123_456_789)).toBe(`1.234.567,89${NBSP}€`);
    expect(formatEUR(4_000)).toBe(`40,00${NBSP}€`);
    expect(formatEUR(5)).toBe(`0,05${NBSP}€`);
  });

  it('formats zero and negative amounts', () => {
    expect(formatEUR(0)).toBe(`0,00${NBSP}€`);
    expect(formatEUR(-894_000)).toBe(`-8.940,00${NBSP}€`);
    expect(formatEUR(-1)).toBe(`-0,01${NBSP}€`);
    expect(formatEUR(-0)).toBe(`0,00${NBSP}€`);
  });

  it('has no float rounding surprises', () => {
    // 100620 / 100 is 1006.2 as a float, and 1.005 * 100 is 100.49999999999999: neither may leak.
    expect(formatEUR(100_620)).toBe(`1.006,20${NBSP}€`);
    expect(formatEUR(101)).toBe(`1,01${NBSP}€`);
    expect(formatEUR(Number.MAX_SAFE_INTEGER)).toBe(
      `90.071.992.547.409,91${NBSP}€`,
    );
  });

  it('refuses anything that is not an integer number of cents', () => {
    expect(() => formatEUR(10.5)).toThrow(RangeError);
    expect(() => formatEUR(Number.NaN)).toThrow(RangeError);
    expect(() => formatEUR(Infinity)).toThrow(RangeError);
  });
});

describe('formatDate', () => {
  it('writes dd/mm/yyyy', () => {
    expect(formatDate('2026-10-19')).toBe('19/10/2026');
    expect(formatDate('2025-01-02')).toBe('02/01/2025');
  });

  it('rejects text that is not an ISO date', () => {
    expect(() => formatDate('19/10/2026')).toThrow(RangeError);
    expect(() => formatDate('2026-1-9')).toThrow(RangeError);
  });
});

describe('formatRate', () => {
  it('writes basis points with a comma and a non-breaking space', () => {
    expect(formatRate(1015)).toBe(`10,15${NBSP}%`);
    expect(formatRate(1040)).toBe(`10,40${NBSP}%`);
    expect(formatRate(800)).toBe(`8,00${NBSP}%`);
    expect(formatRate(5)).toBe(`0,05${NBSP}%`);
  });

  it('rejects rates that are not non-negative integers', () => {
    expect(() => formatRate(10.5)).toThrow(RangeError);
    expect(() => formatRate(-1)).toThrow(RangeError);
  });
});

describe('formatDays', () => {
  it('uses the singular for one day', () => {
    expect(formatDays(1)).toBe('1 día');
    expect(formatDays(0)).toBe('0 días');
    expect(formatDays(402)).toBe('402 días');
  });
});

describe('formatCount', () => {
  it('keeps the thousands dot on four-digit counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(500)).toBe('500');
    expect(formatCount(2000)).toBe('2.000');
    expect(formatCount(1_234_567)).toBe('1.234.567');
  });
});
