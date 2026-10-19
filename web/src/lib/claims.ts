// What the claim screens decide on their own: the cap, the words for a claim's state and the
// save-as of the letter. The numbers of a claim are never computed here: the server freezes them.
import type { ClaimEventKind, ClaimSummary, DebtorKind } from './api-types.ts';
import type { Compensation } from './session.tsx';

// Mirrors the API: more invoices than this go in a second claim.
export const MAX_INVOICES_PER_CLAIM = 100;

// Why a debtor of this kind cannot be claimed, or null when it can.
export function debtorBlocker(kind: DebtorKind): string | null {
  switch (kind) {
    case 'BUSINESS':
      return null;
    case 'UNKNOWN':
      return 'Marca al deudor como empresa o autónomo para poder reclamar.';
    case 'CONSUMER':
      return 'Reclama no reclama a consumidores: quedan fuera de la ley de morosidad.';
    case 'PUBLIC_ADMIN':
      return 'Reclama no tramita reclamaciones a administraciones públicas.';
  }
}

export const EVENT_LABELS: Record<ClaimEventKind, string> = {
  REMINDER_SENT: 'Recordatorio enviado',
  DEMAND_SENT: 'Requerimiento enviado',
  BUROFAX_SENT: 'Burofax enviado',
  MONITORIO_FILED: 'Monitorio presentado',
  PAID: 'Marcada como cobrada',
  NOTE: 'Nota',
};

export type ClaimStatusKind = 'open' | 'paid' | 'blocked';

// The state shown for a claim, from the engine's answer the list carries. A pending action of any
// kind is simply "en curso": which step comes next is the guide's business, not the list's.
export function claimStatus(claim: ClaimSummary): {
  kind: ClaimStatusKind;
  text: string;
} {
  switch (claim.next_action.action) {
    case 'DONE':
      return { kind: 'paid', text: 'Cobrada' };
    case 'BLOCKED':
      return { kind: 'blocked', text: 'Bloqueada' };
    default:
      return { kind: 'open', text: 'En curso' };
  }
}

export const COMPENSATION_LABELS: Record<Compensation, string> = {
  NONE: 'sin compensación',
  PER_INVOICE: '40 € por factura vencida',
  PER_CLAIM: '40 € por reclamación',
};

// Hands the file to the browser through a temporary link. The object URL is released a little
// later: some browsers read it after the click returns.
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
