// The data every demo sandbox starts with. Pure code: it takes "the demo's today" and returns the
// rows, so dates and amounts can be tested without a database.
//
// EVERYTHING here is fictitious and is shown to anyone who opens the demo: invented company
// names that say so ("Ejemplo", "Muestra"...), tax ids that look right but cannot belong to
// anyone (province code 00, which is never issued), addresses and emails only at example.com
// (reserved by RFC 2606), and the IBAN that the banking documentation uses as its example. No
// phone numbers. Do not put a real person, company or address in this file.
import { addDays, type ISODate } from './dates.ts';
import { verifiedRates, type LegalRate } from './rates.ts';

export interface DemoProfile {
  business_name: string;
  tax_id: string;
  address: string;
  iban: string;
  default_compensation: 'PER_CLAIM';
}

export interface DemoDebtor {
  name: string;
  taxId: string;
  email: string;
  kind: 'BUSINESS' | 'PUBLIC_ADMIN' | 'CONSUMER' | 'UNKNOWN';
}

export interface DemoInvoice {
  debtor: number; // index in `debtors`
  number: string;
  issueDate: ISODate;
  dueDate: ISODate;
  amountCents: number;
}

export interface DemoPayment {
  invoice: number; // index in `invoices`
  paidOn: ISODate;
  amountCents: number;
}

export interface DemoData {
  profile: DemoProfile;
  debtors: DemoDebtor[];
  invoices: DemoInvoice[];
  payments: DemoPayment[];
}

const PROFILE: DemoProfile = {
  business_name: 'Estudio Ficticio Norte S.L.',
  tax_id: 'B00000099',
  address: 'Calle de Ejemplo 12\n00000 Ciudad Ejemplo',
  iban: 'ES9121000418450200051332', // the example IBAN of the banking documentation
  default_compensation: 'PER_CLAIM',
};

// The names, tax ids and emails of Talleres Ejemplo and the Ayuntamiento are those of
// data/sample-invoices.csv, so importing that file into a demo recognises them instead of
// creating look-alike debtors. Invoice numbers use another prefix than the sample's for the same
// reason.
//
// Three businesses, one public administration, one consumer and one whose kind is not known yet,
// so the app can show the confirmation step and the refusal for debtors outside Ley 3/2004.
const DEBTORS: readonly DemoDebtor[] = [
  {
    name: 'Talleres Ejemplo S.L.',
    taxId: 'B00000001',
    email: 'talleres@example.com',
    kind: 'BUSINESS',
  },
  {
    name: 'Construcciones Muestra S.A.',
    taxId: 'A00000022',
    email: 'administracion.construcciones@example.com',
    kind: 'BUSINESS',
  },
  {
    name: 'Panadería Ficticia S.L.',
    taxId: 'B00000033',
    email: 'contabilidad.panaderia@example.org',
    kind: 'BUSINESS',
  },
  {
    name: 'Logística Prueba S.L.',
    taxId: 'B00000044',
    email: 'facturas.logistica@example.com',
    kind: 'UNKNOWN',
  },
  {
    name: 'Ayuntamiento de Villaejemplo',
    taxId: 'P0000001A',
    email: 'facturas@example.com',
    kind: 'PUBLIC_ADMIN',
  },
  {
    name: 'Cliente Particular Ejemplo',
    taxId: '00000001R',
    email: 'cliente.particular@example.com',
    kind: 'CONSUMER',
  },
];

// `overdueDays` counts back from the demo's today to the due date; a negative value is a due
// date in the future. The issue date is `termDays` before the due date.
const INVOICES: readonly {
  debtor: number;
  overdueDays: number;
  termDays: number;
  amountCents: number;
}[] = [
  { debtor: 0, overdueDays: 398, termDays: 30, amountCents: 184_250 },
  { debtor: 0, overdueDays: 133, termDays: 30, amountCents: 96_000 }, // partly paid, see PAYMENT
  { debtor: 0, overdueDays: 41, termDays: 60, amountCents: 47_890 },
  { debtor: 0, overdueDays: -21, termDays: 30, amountCents: 128_500 },
  { debtor: 1, overdueDays: 262, termDays: 30, amountCents: 312_000 },
  { debtor: 1, overdueDays: 96, termDays: 60, amountCents: 74_525 },
  { debtor: 1, overdueDays: -7, termDays: 30, amountCents: 56_400 },
  { debtor: 2, overdueDays: 58, termDays: 30, amountCents: 58_300 },
  { debtor: 2, overdueDays: -14, termDays: 30, amountCents: 35_750 },
  { debtor: 3, overdueDays: 73, termDays: 30, amountCents: 143_000 },
  { debtor: 3, overdueDays: 10, termDays: 30, amountCents: 29_900 },
  { debtor: 4, overdueDays: 108, termDays: 60, amountCents: 520_000 },
  { debtor: 4, overdueDays: 27, termDays: 30, amountCents: 187_450 },
  { debtor: 5, overdueDays: 187, termDays: 30, amountCents: 18_900 },
];
// 40 % of the second invoice, paid long after its due date (133 days ago) and before today.
const PAYMENT = { invoice: 1, amountCents: 38_400, daysAgo: 66 };

// The day the demo calls "today": the real day, unless the legal rates only reach less far. The
// interest of an invoice needs a verified rate for every day up to the day it is calculated, so
// a demo built on a day after the last verified semester would show errors instead of numbers.
// null when there is no verified rate at all.
export function demoToday(
  today: ISODate,
  rates: readonly LegalRate[],
): ISODate | null {
  let last: ISODate | null = null;
  for (const { semester_end } of verifiedRates(rates)) {
    if (last === null || semester_end > last) last = semester_end;
  }
  if (last === null) return null;
  return today < last ? today : last;
}

export function buildDemoData(today: ISODate): DemoData {
  const invoices = INVOICES.map((invoice, index): DemoInvoice => {
    const dueDate = addDays(today, -invoice.overdueDays);
    const issueDate = addDays(dueDate, -invoice.termDays);
    return {
      debtor: invoice.debtor,
      number: `FA-${issueDate.slice(0, 4)}-${String(index + 1).padStart(3, '0')}`,
      issueDate,
      dueDate,
      amountCents: invoice.amountCents,
    };
  });
  return {
    profile: PROFILE,
    debtors: [...DEBTORS],
    invoices,
    payments: [
      {
        invoice: PAYMENT.invoice,
        paidOn: addDays(today, -PAYMENT.daysAgo),
        amountCents: PAYMENT.amountCents,
      },
    ],
  };
}
