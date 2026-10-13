// Money is always an integer number of cents (plan 4.1). Nothing here uses floats for amounts.

declare const centsBrand: unique symbol;
// The brand makes the compiler refuse a plain `number` where cents are expected.
export type Cents = number & { readonly [centsBrand]: true };

export function toCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Cents must be a safe integer, got ${String(value)}`);
  }
  return value as Cents;
}

export type MoneyErrorCode =
  | 'EMPTY'
  | 'NEGATIVE'
  | 'ZERO'
  | 'EXPONENT'
  | 'INVALID_FORMAT'
  | 'AMBIGUOUS_SEPARATOR'
  | 'TOO_MANY_DECIMALS'
  | 'TOO_LARGE';

// A result object instead of an exception: the CSV importer reports one error per row.
export type ParseMoneyResult =
  { ok: true; cents: Cents } | { ok: false; code: MoneyErrorCode };

const fail = (code: MoneyErrorCode): ParseMoneyResult => ({ ok: false, code });

// One optional `€` or `EUR` (any case), at the start or at the end. Any other currency is an error.
const CURRENCY_MARK = /^(?:€|EUR)\s*|\s*(?:€|EUR)$/i;

// `integerPart` is digits only, or digit groups of 3 joined by `groupSep` ("1.234.567").
// Returns the digits without separators, or null if the shape is wrong.
function integerDigits(integerPart: string, groupSep: string): string | null {
  if (/^\d+$/.test(integerPart)) return integerPart;
  const [first = '', ...rest] = integerPart.split(groupSep);
  if (!/^[1-9]\d{0,2}$/.test(first) || !rest.every((g) => /^\d{3}$/.test(g))) {
    return null;
  }
  return integerPart.split(groupSep).join('');
}

// Rules from plan 4.8, plus: "1.5" and "1,234.56" are accepted as decimal dot (the last
// separator wins); spaces or apostrophes as thousands separators are rejected.
export function parseMoney(text: string): ParseMoneyResult {
  const body = text.trim().replace(CURRENCY_MARK, '').trim();

  if (body === '') return fail('EMPTY');
  if (body.startsWith('-')) return fail('NEGATIVE');
  if (/\d[eE][+-]?\d/.test(body)) return fail('EXPONENT');
  if (!/^[\d.,]+$/.test(body)) return fail('INVALID_FORMAT');

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  let digits: string | null = body;
  let decimals = '';

  if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot > lastComma ? '.' : ',';
    const other = sep === '.' ? ',' : '.';
    const lastSep = Math.max(lastDot, lastComma);
    const head = body.slice(0, lastSep);
    const tail = body.slice(lastSep + 1);

    if (tail === '') return fail('INVALID_FORMAT');
    if (tail.length > 3 || (tail.length === 3 && body.includes(other))) {
      return fail('TOO_MANY_DECIMALS');
    }
    if (tail.length === 3) {
      // Only one kind of separator. "1.234" is thousands, but "1,234" could be either.
      if (sep === ',') return fail('AMBIGUOUS_SEPARATOR');
      digits = integerDigits(body, '.');
    } else {
      digits = integerDigits(head, other);
      decimals = tail;
    }
  }

  if (digits === null) return fail('INVALID_FORMAT');

  const total = Number(digits) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(total)) return fail('TOO_LARGE');
  if (total === 0) return fail('ZERO');
  return { ok: true, cents: total as Cents };
}

// 123456 -> "1.234,56 €". Written by hand instead of Intl: es-ES skips the dot for 4-digit
// numbers and uses a non-breaking space; here the format is always the same.
export function formatEUR(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rest = abs % 100;
  // Exact: (abs - rest) is a multiple of 100, so there is no float rounding.
  const euros = String((abs - rest) / 100).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  );
  return `${sign}${euros},${String(rest).padStart(2, '0')} €`;
}
