import { describe, expect, it } from 'vitest';
import { formatEUR } from './format.ts';
import {
  MAX_PAYMENT_CENTS,
  moneyErrorMessage,
  parseMoney,
  type MoneyError,
} from './money.ts';

const cents = (input: string): number | MoneyError => {
  const result = parseMoney(input);
  return result.ok ? result.cents : result.error;
};

describe('parseMoney: what it accepts', () => {
  it.each([
    ['1.234,56', 123_456],
    ['1234,56', 123_456],
    ['1234.56', 123_456],
    ['1234', 123_400],
    ['0,5', 50],
    ['0,05', 5],
    ['7', 700],
    ['12,3', 1230],
    ['1.234.567,89', 123_456_789],
    ['1,234.56', 123_456],
    ['12,345.6', 1_234_560],
    ['1.234.567', 123_456_700],
    ['  250,50  ', 25_050],
    ['007,10', 710],
    ['1.234,56 €', 123_456],
    ['99.999.999,99', 9_999_999_999],
  ])('reads %s', (input, expected) => {
    expect(cents(input)).toBe(expected);
  });

  it('reads the text formatEUR writes (non-breaking space and euro sign)', () => {
    expect(cents(formatEUR(123_456))).toBe(123_456);
  });
});

describe('parseMoney: what it refuses, and why', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['€', 'empty'],
    ['-5', 'not_positive'],
    ['-0,50', 'not_positive'],
    ['0', 'not_positive'],
    ['0,00', 'not_positive'],
    ['00', 'not_positive'],
    ['abc', 'invalid'],
    ['12a', 'invalid'],
    ['1 234', 'invalid'],
    ['+5', 'invalid'],
    ['1e3', 'invalid'],
    ['12,', 'invalid'],
    [',5', 'invalid'],
    ['.', 'invalid'],
    ['1,2,3', 'invalid'],
    ['1.2.3', 'invalid'],
    ['12.34.5', 'invalid'],
    ['1.2,3.4', 'invalid'],
    ['1,23,456.7', 'invalid'],
    ['1,5678', 'too_many_decimals'],
    ['1234.567', 'ambiguous'],
    ['1.234,567', 'too_many_decimals'],
    ['10,000', 'ambiguous'],
    ['1,234', 'ambiguous'],
    ['1.234', 'ambiguous'],
    ['0,500', 'ambiguous'],
    ['100.000.000,01', 'too_large'],
    ['999999999999999', 'too_large'],
  ] as const)('refuses "%s" as %s', (input, error) => {
    expect(cents(input)).toBe(error);
  });

  it('never lets a huge integer reach Number()', () => {
    expect(cents('9'.repeat(40))).toBe('too_large');
    expect(cents('0'.repeat(40) + '5')).toBe(500);
  });

  it('honours a different ceiling and the default of 100.000.000,00 EUR', () => {
    expect(MAX_PAYMENT_CENTS).toBe(10_000_000_000);
    expect(parseMoney('100.000.000,00')).toEqual({
      ok: true,
      cents: 10_000_000_000,
    });
    expect(parseMoney('101,00', 10_000)).toEqual({
      ok: false,
      error: 'too_large',
    });
    expect(parseMoney('100,00', 10_000)).toEqual({ ok: true, cents: 10_000 });
  });

  it('has a Spanish message for every error', () => {
    const errors: MoneyError[] = [
      'empty',
      'invalid',
      'not_positive',
      'too_many_decimals',
      'ambiguous',
      'too_large',
    ];
    for (const error of errors) {
      expect(moneyErrorMessage(error)).toMatch(/[a-záéíóú]{4}/i);
    }
    expect(moneyErrorMessage('ambiguous')).toContain('1,23');
  });
});

describe('parseMoney: round trip with formatEUR', () => {
  it('reads back the amounts that formatEUR writes, from 1 cent to 20.000,00 EUR', () => {
    // Every third value, plus the last: the digit patterns (thousands dots, trailing zeros) all recur.
    for (
      let value = 1;
      value <= 2_000_000;
      value += value === 1999999 ? 1 : 3
    ) {
      const result = parseMoney(formatEUR(value));
      if (!result.ok || result.cents !== value) {
        throw new Error(
          `${String(value)} -> ${formatEUR(value)} -> ${JSON.stringify(result)}`,
        );
      }
    }
  });

  it('refuses the zero amount that formatEUR writes', () => {
    expect(parseMoney(formatEUR(0))).toEqual({
      ok: false,
      error: 'not_positive',
    });
  });

  it('also reads the plain decimal form of the same amounts', () => {
    for (let value = 1; value <= 200_000; value += 7) {
      const plain = `${String(Math.trunc(value / 100))},${String(value % 100).padStart(2, '0')}`;
      expect(parseMoney(plain)).toEqual({ ok: true, cents: value });
    }
  });
});
