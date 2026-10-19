// Display helpers. Money is always integer cents; nothing here goes through a binary float.
const NBSP = ' ';

// useGrouping 'always': es-ES skips the thousands dot for 4-digit numbers by default, and an
// amount like 8940,00 € next to 18.940,00 € reads badly.
const euro = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
});

// 894000 -> "8.940,00 €" (non-breaking space before the euro sign).
export function formatEUR(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError('Amounts are integer cents');
  }
  const abs = Math.abs(cents);
  const sign = cents < 0 ? '-' : '';
  // A decimal string, not a number: Intl formats it exactly.
  const decimal = `${sign}${String(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  return euro.format(decimal as `${number}`);
}

// "2026-10-19" -> "19/10/2026"
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''}`;
}

// Basis points -> "10,15 %" (non-breaking space, so the sign never wraps alone).
export function formatRate(basisPoints: number): string {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError('A rate is a non-negative integer of basis points');
  }
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, '0');
  return `${String(whole)},${fraction}${NBSP}%`;
}

export function formatDays(days: number): string {
  return `${String(days)} ${days === 1 ? 'día' : 'días'}`;
}

// "2027-H1" -> "primer semestre de 2027" (the form the API names the semesters it lacks a rate for).
export function formatSemester(code: string): string {
  const match = /^(\d{4})-H([12])$/.exec(code);
  if (!match) return code;
  return `${match[2] === '1' ? 'primer' : 'segundo'} semestre de ${match[1] ?? ''}`;
}
