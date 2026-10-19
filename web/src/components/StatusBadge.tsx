import type { InvoiceView } from '../lib/api-types.ts';

export type BadgeKind = 'overdue' | 'soon' | 'paid' | 'dispute';

export function badgeKind(invoice: InvoiceView): BadgeKind {
  if (invoice.status === 'PAID') return 'paid';
  if (invoice.status === 'DISPUTED') return 'dispute';
  return invoice.overdue ? 'overdue' : 'soon';
}

const TEXT: Record<BadgeKind, string> = {
  overdue: 'Vencida',
  soon: 'Por vencer',
  paid: 'Pagada',
  dispute: 'En disputa',
};

// One small drawing per state: the state is never told by colour alone.
const ICON: Record<BadgeKind, string> = {
  overdue: 'M8 2 L15 14 H1 Z M8 6.5 V10 M8 12 V12.1',
  soon: 'M8 2 A6 6 0 1 0 8.01 2 M8 5 V8.5 L10.5 10',
  paid: 'M2 8.5 L6 12.5 L14 4',
  dispute: 'M2 3 H14 V11 H8 L4 14 V11 H2 Z',
};

export function StatusBadge({ invoice }: { invoice: InvoiceView }) {
  const kind = badgeKind(invoice);
  return (
    <span className={`badge ${kind}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d={ICON[kind]} />
      </svg>
      {TEXT[kind]}
    </span>
  );
}
