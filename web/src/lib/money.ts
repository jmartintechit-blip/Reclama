// Reads the amount a person types ("1.234,56", "1234.56", "0,5") into integer cents. Integer
// arithmetic only: the text is split into digits and never goes through a float, so 0,1 + 0,2
// style surprises cannot happen. The server stays the authority; this only tells the person
// at once what is wrong.

// Client-side ceiling: 100.000.000,00 EUR, far below the server's own maximum.
export const MAX_PAYMENT_CENTS = 10_000_000_000;

export type MoneyError =
  | 'empty'
  | 'invalid'
  | 'not_positive'
  | 'too_many_decimals'
  | 'ambiguous'
  | 'too_large';

export type MoneyResult =
  { ok: true; cents: number } | { ok: false; error: MoneyError };

const bad = (error: MoneyError): MoneyResult => ({ ok: false, error });

// "1" to "999" followed by groups of exactly three digits: a valid use of a thousands separator.
const grouped = (separator: '.' | ',') =>
  new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`);

export function parseMoney(
  input: string,
  maxCents: number = MAX_PAYMENT_CENTS,
): MoneyResult {
  // A trailing euro sign is what formatEUR produces, so a pasted amount works.
  const text = input.replace(/\s*€\s*$/, '').trim();
  if (text === '') return bad('empty');
  if (text.startsWith('-')) return bad('not_positive');
  if (!/^[\d.,]+$/.test(text)) return bad('invalid');

  let whole: string;
  let fraction = '';
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const hasBoth = lastComma !== -1 && lastDot !== -1;
  const decimalAt = Math.max(lastComma, lastDot);

  if (decimalAt === -1) {
    whole = text;
  } else {
    const separator = text[decimalAt] as '.' | ',';
    const left = text.slice(0, decimalAt);
    const right = text.slice(decimalAt + 1);
    const other = separator === ',' ? '.' : ',';
    if (right === '' || left === '') return bad('invalid');
    if (hasBoth) {
      // "1.234,56" or "1,234.56": the last separator is the decimal one and the other must be
      // a well-formed thousands separator.
      if (!grouped(other).test(left)) return bad('invalid');
      whole = left.replaceAll(other, '');
    } else if (left.includes(separator)) {
      // "1.234.567": the same separator twice or more can only be thousands.
      if (!grouped(separator).test(text)) return bad('invalid');
      return finish(text.replaceAll(separator, ''), '', maxCents);
    } else {
      whole = left;
    }
    // "1,234" could be 1,23 EUR mistyped or one thousand two hundred and thirty-four: never guess.
    if (right.length === 3 && !hasBoth) return bad('ambiguous');
    if (right.length > 2) return bad('too_many_decimals');
    fraction = right;
  }
  return finish(whole, fraction, maxCents);
}

function finish(
  whole: string,
  fraction: string,
  maxCents: number,
): MoneyResult {
  // More digits than any allowed amount: refuse before the digits become a number.
  if (whole.replace(/^0+/, '').length > 12) return bad('too_large');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0) return bad('not_positive');
  if (cents > maxCents) return bad('too_large');
  return { ok: true, cents };
}

export function moneyErrorMessage(error: MoneyError): string {
  switch (error) {
    case 'empty':
      return 'Escribe el importe cobrado.';
    case 'invalid':
      return 'Escribe solo números, por ejemplo 1.234,56.';
    case 'not_positive':
      return 'El importe tiene que ser mayor que cero.';
    case 'too_many_decimals':
      return 'Usa como máximo dos decimales, por ejemplo 1.234,56.';
    case 'ambiguous':
      return 'No sabemos si es una cifra con decimales o con miles. Escribe los decimales con coma (1,23) o el importe completo (1234 o 1.234,00).';
    case 'too_large':
      return 'El importe es demasiado grande.';
  }
}
