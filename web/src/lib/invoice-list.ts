// What the invoice list decides on its own: the filter chips and the words about a due date.
import type { InvoiceView } from './api-types.ts';
import { daysBetween } from './dates.ts';
import { formatDays } from './format.ts';

export type FilterId = 'todas' | 'vencidas' | 'no-vencidas' | 'parcial';

// The API filters by stored status only (OPEN, PAID, DISPUTED), not by "overdue" or "partly
// paid", which it derives. So these chips filter the invoices of the page already loaded.
export const FILTERS: {
  id: FilterId;
  label: string;
  test: (invoice: InvoiceView) => boolean;
}[] = [
  { id: 'todas', label: 'Todas', test: () => true },
  { id: 'vencidas', label: 'Vencidas', test: (i) => i.overdue },
  {
    id: 'no-vencidas',
    label: 'No vencidas',
    test: (i) => !i.overdue && i.status !== 'PAID',
  },
  {
    id: 'parcial',
    label: 'Cobro parcial',
    test: (i) => i.paid_cents > 0 && i.status !== 'PAID',
  },
];

export function filterFromParam(value: string | null): FilterId {
  return FILTERS.find((f) => f.id === value)?.id ?? 'todas';
}

// "402 días de retraso" / "vence en 17 días" / "vence hoy"; null when there is nothing to say
// (a paid invoice, or one whose due date could not be worked out).
export function dueNote(invoice: InvoiceView, today: string): string | null {
  const due = invoice.due_date_effective;
  if (invoice.status === 'PAID' || due === null) return null;
  if (invoice.overdue) return `${formatDays(invoice.days_overdue)} de retraso`;
  const left = daysBetween(today, due);
  if (left === 0) return 'vence hoy';
  return left > 0 ? `vence en ${formatDays(left)}` : null;
}
