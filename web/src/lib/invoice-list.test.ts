import { describe, expect, it } from 'vitest';
import type { InvoiceView } from './api-types.ts';
import { daysBetween, todayMadrid } from './dates.ts';
import { formatSemester } from './format.ts';
import { dueNote, FILTERS, filterFromParam } from './invoice-list.ts';

const base: InvoiceView = {
  id: 'i1',
  debtor_id: 'd1',
  number: 'FA-1',
  issue_date: '2026-08-01',
  due_date: '2026-09-01',
  amount_cents: 100_000,
  agreed_rate_bp: null,
  status: 'OPEN',
  paid_cents: 0,
  balance_cents: 100_000,
  due_date_effective: '2026-09-01',
  due_date_estimated: false,
  overdue: true,
  days_overdue: 48,
  interest_cents: 900,
  interest_error: null,
};
const notDue = { ...base, overdue: false, days_overdue: 0 };

const filter = (id: string) => {
  const found = FILTERS.find((f) => f.id === id);
  if (!found) throw new Error(`no filter ${id}`);
  return found.test;
};

describe('dueNote', () => {
  it('counts the days late of an overdue invoice', () => {
    expect(dueNote(base, '2026-10-19')).toBe('48 días de retraso');
    expect(dueNote({ ...base, days_overdue: 1 }, '2026-10-19')).toBe(
      '1 día de retraso',
    );
  });

  it('counts the days left of an invoice that is not due yet, and says "hoy"', () => {
    const on = (due: string) => ({ ...notDue, due_date_effective: due });
    expect(dueNote(on('2026-11-05'), '2026-10-19')).toBe('vence en 17 días');
    expect(dueNote(on('2026-10-20'), '2026-10-19')).toBe('vence en 1 día');
    expect(dueNote(on('2026-10-19'), '2026-10-19')).toBe('vence hoy');
  });

  it('says nothing for a paid invoice or one without a due date', () => {
    expect(dueNote({ ...notDue, status: 'PAID' }, '2026-10-19')).toBeNull();
    expect(
      dueNote({ ...notDue, due_date_effective: null }, '2026-10-19'),
    ).toBeNull();
  });
});

describe('filters', () => {
  it('"Vencidas" follows the overdue flag the API computes', () => {
    expect(filter('vencidas')(base)).toBe(true);
    expect(filter('vencidas')(notDue)).toBe(false);
  });

  it('"No vencidas" leaves out overdue and paid invoices', () => {
    expect(filter('no-vencidas')(notDue)).toBe(true);
    expect(filter('no-vencidas')(base)).toBe(false);
    expect(filter('no-vencidas')({ ...notDue, status: 'PAID' })).toBe(false);
  });

  it('"Cobro parcial" is something paid but not everything', () => {
    expect(filter('parcial')({ ...base, paid_cents: 500 })).toBe(true);
    expect(filter('parcial')(base)).toBe(false);
    expect(
      filter('parcial')({ ...base, paid_cents: 100_000, status: 'PAID' }),
    ).toBe(false);
  });

  it('falls back to "todas" for an unknown value in the URL', () => {
    expect(filterFromParam('vencidas')).toBe('vencidas');
    expect(filterFromParam('x')).toBe('todas');
    expect(filterFromParam(null)).toBe('todas');
  });
});

describe('dates', () => {
  it('takes today in Madrid, whatever the time zone of the browser', () => {
    // 22:30 UTC on 18 October is already 00:30 on the 19th in Madrid (UTC+2 until 25 October).
    expect(todayMadrid(new Date('2026-10-18T22:30:00Z'))).toBe('2026-10-19');
    expect(todayMadrid(new Date('2026-10-18T21:30:00Z'))).toBe('2026-10-18');
  });

  it('counts whole days between ISO dates, across a leap day and a new year', () => {
    expect(daysBetween('2026-10-19', '2026-10-19')).toBe(0);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-10-19', '2026-10-01')).toBe(-18);
    expect(() => daysBetween('19/10/2026', '2026-10-19')).toThrow(RangeError);
  });

  it('writes the semesters the API names in words', () => {
    expect(formatSemester('2027-H1')).toBe('primer semestre de 2027');
    expect(formatSemester('2016-H2')).toBe('segundo semestre de 2016');
    expect(formatSemester('raro')).toBe('raro');
  });
});
