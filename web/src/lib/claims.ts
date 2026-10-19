// What the claim screens decide on their own: the cap, the words for a claim's state and the
// save-as of the letter. The numbers of a claim are never computed here: the server freezes them.
import type {
  ClaimDetail,
  ClaimEventKind,
  ClaimSummary,
  DebtorKind,
} from './api-types.ts';
import { addDays } from './dates.ts';
import { formatDate, formatEUR } from './format.ts';
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

// Reflects PAYMENT_DEADLINE_DAYS of the server (server/services/letter.ts): the days the letter
// gives to pay, counted from today. If the server changes it, change it here too.
export const PAYMENT_DEADLINE_DAYS = 10;

// The hole left in a template when a value is not known: better visible than invented.
export const TEMPLATE_GAP = '[…]';

// "A", "A y B", "A, B y C".
export function joinWithY(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`;
}

// What each {{placeholder}} of the server's templates is filled with. Unknown means undefined: the
// template then shows a gap instead of a made-up value.
export function templateValues(
  claim: ClaimDetail,
  businessName: string | null | undefined,
  today: string,
): Record<string, string | undefined> {
  const lastDemand = claim.events
    .filter((event) => event.kind === 'DEMAND_SENT')
    .map((event) => event.occurred_on)
    .sort()
    .at(-1);
  const sender = businessName?.trim();
  return {
    debtor_name: claim.debtor_name,
    invoice_numbers: joinWithY(claim.lines.map((line) => line.number)),
    total: formatEUR(claim.total_cents),
    deadline: formatDate(addDays(today, PAYMENT_DEADLINE_DAYS)),
    sender_name: sender === '' ? undefined : sender,
    demand_date: lastDemand === undefined ? undefined : formatDate(lastDemand),
  };
}

// Fills the {{placeholders}} in ONE pass, so a value that holds "{{total}}" is not substituted
// again. A placeholder without a value becomes the gap and is listed in `missing`.
export function fillTemplate(
  text: string,
  values: Record<string, string | undefined>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(/\{\{([^{}]*)\}\}/g, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      if (!missing.includes(name)) missing.push(name);
      return TEMPLATE_GAP;
    }
    return value;
  });
  return { text: filled, missing };
}

// What a gap means, for the note under a template.
export const MISSING_VALUE_LABELS: Record<string, string> = {
  sender_name: 'tu nombre o razón social (se rellena en el perfil)',
  demand_date: 'la fecha del requerimiento (aún no has registrado ninguno)',
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
