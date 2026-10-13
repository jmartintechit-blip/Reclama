import { describe, expect, it } from 'vitest';
import {
  formatEUR,
  parseMoney,
  toCents,
  type MoneyErrorCode,
} from './money.ts';

describe('toCents', () => {
  it('accepts safe integers, including zero and negatives', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(123456)).toBe(123456);
    expect(toCents(-5)).toBe(-5);
  });

  it.each([1.5, 0.1 + 0.2, NaN, Infinity, 2 ** 53])('rejects %s', (value) => {
    expect(() => toCents(value)).toThrow(RangeError);
  });

  it('is required by the compiler: a plain number is not Cents', () => {
    // @ts-expect-error a plain number is not Cents
    formatEUR(5);
    expect(formatEUR(toCents(5))).toBe('0,05 €');
  });
});

describe('parseMoney: valid formats', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,5', 123450],
    ['1.234', 123400],
    ['1,234.56', 123456],
    ['1,234,567.89', 123456789],
    ['1.234.567,89', 123456789],
    ['7', 700],
    ['7,00', 700],
    ['  7,00  ', 700],
    ['0,05', 5],
    ['0,5', 50],
    ['1.000', 100000],
    ['12.5', 1250],
    ['12,50 €', 1250],
    ['12,50€', 1250],
    ['€ 12,50', 1250],
    ['€12,50', 1250],
    ['12,50 EUR', 1250],
    ['eur 12,50', 1250],
    ['1.234,56 €', 123456],
    ['90.071.992.547.409,91', 9007199254740991],
  ])('parses %j as %i cents', (text, cents) => {
    expect(parseMoney(text)).toEqual({ ok: true, cents });
  });
});

describe('parseMoney: errors', () => {
  it.each<[string, MoneyErrorCode]>([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['€', 'EMPTY'],
    ['12,345', 'AMBIGUOUS_SEPARATOR'],
    ['1,234', 'AMBIGUOUS_SEPARATOR'],
    ['1,234,567', 'AMBIGUOUS_SEPARATOR'],
    ['-5', 'NEGATIVE'],
    ['-5,00 €', 'NEGATIVE'],
    ['0', 'ZERO'],
    ['0,00', 'ZERO'],
    ['1e3', 'EXPONENT'],
    ['1E+3', 'EXPONENT'],
    ['2,5e-3', 'EXPONENT'],
    ['12,3456', 'TOO_MANY_DECIMALS'],
    ['1.2345', 'TOO_MANY_DECIMALS'],
    ['1.234,567', 'TOO_MANY_DECIMALS'],
    ['1.2.3', 'INVALID_FORMAT'],
    ['1,2,3', 'INVALID_FORMAT'],
    ['1.23.456', 'INVALID_FORMAT'],
    ['01.234', 'INVALID_FORMAT'],
    ['1234.567', 'INVALID_FORMAT'],
    ['1.234,56,7', 'INVALID_FORMAT'],
    ['12,', 'INVALID_FORMAT'],
    [',50', 'INVALID_FORMAT'],
    ['abc', 'INVALID_FORMAT'],
    ['12 345', 'INVALID_FORMAT'],
    ['+5', 'INVALID_FORMAT'],
    ['$5', 'INVALID_FORMAT'],
    ['5 USD', 'INVALID_FORMAT'],
    ['€5€', 'INVALID_FORMAT'],
    ['١٢', 'INVALID_FORMAT'],
    ['90.071.992.547.409,92', 'TOO_LARGE'],
    ['99999999999999999999', 'TOO_LARGE'],
  ])('rejects %j with %s', (text, code) => {
    expect(parseMoney(text)).toEqual({ ok: false, code });
  });
});

describe('formatEUR', () => {
  it.each([
    [0, '0,00 €'],
    [1, '0,01 €'],
    [99, '0,99 €'],
    [100, '1,00 €'],
    [99900, '999,00 €'],
    [100000, '1.000,00 €'],
    [123456, '1.234,56 €'],
    [100000000, '1.000.000,00 €'],
    [-1, '-0,01 €'],
    [-123456, '-1.234,56 €'],
    [Number.MAX_SAFE_INTEGER, '90.071.992.547.409,91 €'],
  ])('formats %i cents as %j', (cents, text) => {
    expect(formatEUR(toCents(cents))).toBe(text);
  });

  it('uses a normal space before the euro sign, never a non-breaking one', () => {
    const text = formatEUR(toCents(123456));
    expect(text).not.toContain(' ');
    expect(text.at(-2)).toBe(' ');
  });
});

describe('formatEUR and parseMoney round trip', () => {
  it('parses back what it formatted', () => {
    for (let i = 1; i <= 5000; i++) {
      const cents = toCents(i * 997);
      expect(parseMoney(formatEUR(cents))).toEqual({ ok: true, cents });
    }
    for (const value of [
      1,
      99,
      100,
      100000,
      100000000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const cents = toCents(value);
      expect(parseMoney(formatEUR(cents))).toEqual({ ok: true, cents });
    }
  });
});
