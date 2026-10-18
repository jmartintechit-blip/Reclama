// The next-action engine of a claim: from the events recorded so far it names the next step of the
// escalation ladder (reminder, formal demand, burofax, monitorio procedure). Pure code: no I/O,
// no clock; the caller passes `today`.
//
// The waits between steps are heuristics of this application, NOT legal deadlines: Ley 3/2004
// does not require any reminder, demand or waiting time before interest runs or before going to
// court. They are configurable and every `reason` returned says so. The engine always names the
// next step; `earliest_on` tells from which day it is suggested.
import type { DebtorKind } from './claim.ts';
import { addDays, diffDays, parseISODate, type ISODate } from './dates.ts';

export type StepEventKind =
  'REMINDER_SENT' | 'DEMAND_SENT' | 'BUROFAX_SENT' | 'MONITORIO_FILED';
export type EscalationEventKind = StepEventKind | 'PAID' | 'NOTE';

export interface EscalationEvent {
  kind: EscalationEventKind;
  occurred_on: ISODate;
}

export type PendingAction =
  'SEND_REMINDER' | 'SEND_DEMAND' | 'SEND_BUROFAX' | 'FILE_MONITORIO';
export type NextActionKind = PendingAction | 'DONE' | 'BLOCKED';

// Days to wait after the previous step. There is no wait for the reminder: it has no previous
// step and is suggested right away.
export interface EscalationWaits {
  demandDays: number;
  burofaxDays: number;
  monitorioDays: number;
}

export const DEFAULT_ESCALATION_WAITS: EscalationWaits = {
  demandDays: 7, // after the last step
  burofaxDays: 10, // after the demand
  monitorioDays: 10, // after the burofax
};

// The general period for personal actions is five years (Codigo Civil art. 1964.2); the warning
// starts when the oldest due date is more than four and a half years old.
export const LIMITATION_WARNING_MONTHS = 54;

export interface EscalationWarning {
  code: 'POSSIBLE_LIMITATION';
  message: string;
}

interface Common {
  reason: string; // Spanish: the freelancer reads it
  wait_days: number;
  warnings: EscalationWarning[];
}

export type NextAction =
  | (Common & { action: PendingAction; earliest_on: ISODate })
  | (Common & { action: 'DONE' | 'BLOCKED'; earliest_on: null });

export interface EscalationClaim {
  // The frozen lines of the claim: the interest starts the day after the due date, so the first
  // segment of a line tells which due date was used.
  lines: readonly { segments: readonly { start: ISODate }[] }[];
}

export interface NextActionInput {
  today: ISODate;
  claim: EscalationClaim;
  events: readonly EscalationEvent[]; // in the order they were recorded
  debtorKind: DebtorKind;
  config?: Partial<EscalationWaits>;
}

const STEP_ORDER: readonly StepEventKind[] = [
  'REMINDER_SENT',
  'DEMAND_SENT',
  'BUROFAX_SENT',
  'MONITORIO_FILED',
];

// What follows each recorded step. `done` is how the step is named in the reasons.
const AFTER: Record<
  Exclude<StepEventKind, 'MONITORIO_FILED'>,
  { done: string; next: Exclude<PendingAction, 'SEND_REMINDER'> }
> = {
  REMINDER_SENT: { done: 'el recordatorio', next: 'SEND_DEMAND' },
  DEMAND_SENT: { done: 'el requerimiento', next: 'SEND_BUROFAX' },
  BUROFAX_SENT: { done: 'el burofax', next: 'FILE_MONITORIO' },
};

const TO_DO: Record<Exclude<PendingAction, 'SEND_REMINDER'>, string> = {
  SEND_DEMAND: 'enviar el requerimiento formal',
  SEND_BUROFAX: 'enviar el burofax',
  FILE_MONITORIO: 'presentar la petición del procedimiento monitorio',
};

const HEURISTIC =
  'Esa espera es una pauta orientativa de Reclama, configurable; no es un plazo legal.';

const BLOCKED_REASON: Record<Exclude<DebtorKind, 'BUSINESS'>, string> = {
  CONSUMER:
    'El deudor es un consumidor: los pagos de operaciones en las que interviene un consumidor quedan fuera de la Ley 3/2004, así que Reclama no calcula ni guía esta reclamación.',
  PUBLIC_ADMIN:
    'El deudor es una administración pública: sus plazos de pago y su reclamación siguen reglas específicas de la contratación pública que Reclama no cubre.',
  UNKNOWN:
    'Aún no sabemos si el deudor es una empresa o un profesional. Confírmalo en su ficha antes de seguir: la Ley 3/2004 solo se aplica entre empresas.',
};

const formatDate = (date: ISODate): string =>
  `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

// `date` minus whole calendar months; a day that does not exist in the target month becomes the
// last day of that month (31 Aug minus 6 months is 28 Feb).
function monthsBefore(date: ISODate, months: number): ISODate {
  const total =
    Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1) - months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), lastDay);
  const result = parseISODate(
    `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
  if (result === null)
    throw new RangeError(
      `${date} minus ${String(months)} months is out of range`,
    );
  return result;
}

function limitationWarnings(
  today: ISODate,
  claim: EscalationClaim,
): EscalationWarning[] {
  let oldest: ISODate | null = null;
  for (const line of claim.lines) {
    const first = line.segments[0];
    if (first === undefined) continue;
    const dueDate = addDays(first.start, -1);
    if (oldest === null || dueDate < oldest) oldest = dueDate;
  }
  if (
    oldest === null ||
    oldest >= monthsBefore(today, LIMITATION_WARNING_MONTHS)
  ) {
    return [];
  }
  return [
    {
      code: 'POSSIBLE_LIMITATION',
      message: `La factura más antigua venció el ${formatDate(oldest)}, hace más de cuatro años y medio. Las acciones personales sin plazo especial prescriben a los cinco años desde que se puede exigir el cumplimiento (art. 1964 del Código Civil), así que esta deuda podría estar a punto de prescribir o haber prescrito ya. Una reclamación extrajudicial del acreedor interrumpe la prescripción (art. 1973 del Código Civil). Consulta cuanto antes a un abogado.`,
    },
  ];
}

export function nextAction(input: NextActionInput): NextAction {
  const { today, claim, events, debtorKind } = input;
  const waits = { ...DEFAULT_ESCALATION_WAITS, ...input.config };

  // Nothing left to do whoever the debtor is.
  if (events.some((event) => event.kind === 'PAID')) {
    return {
      action: 'DONE',
      reason: 'La reclamación está marcada como pagada.',
      earliest_on: null,
      wait_days: 0,
      warnings: [],
    };
  }

  if (debtorKind !== 'BUSINESS') {
    return {
      action: 'BLOCKED',
      reason: BLOCKED_REASON[debtorKind],
      earliest_on: null,
      wait_days: 0,
      warnings: [],
    };
  }

  // The most advanced recorded step decides (a step may be skipped), and the wait counts from
  // the latest date of that step.
  let last: { kind: StepEventKind; rank: number; on: ISODate } | null = null;
  for (const event of events) {
    const rank = (STEP_ORDER as readonly string[]).indexOf(event.kind);
    if (rank < 0) continue; // PAID was handled above; NOTE is ignored
    if (
      last === null ||
      rank > last.rank ||
      (rank === last.rank && event.occurred_on > last.on)
    ) {
      last = {
        kind: event.kind as StepEventKind,
        rank,
        on: event.occurred_on,
      };
    }
  }

  if (last === null) {
    return {
      action: 'SEND_REMINDER',
      reason:
        'Todavía no has registrado ningún paso. Un recordatorio amable es opcional: si prefieres, puedes saltar directamente al requerimiento formal.',
      earliest_on: today,
      wait_days: 0,
      warnings: limitationWarnings(today, claim),
    };
  }

  if (last.kind === 'MONITORIO_FILED') {
    return {
      action: 'DONE',
      reason: `Registraste la petición del procedimiento monitorio el ${formatDate(last.on)}. Ahora toca seguir el procedimiento ante el juzgado.`,
      earliest_on: null,
      wait_days: 0,
      warnings: [],
    };
  }

  const { done, next } = AFTER[last.kind];
  const waitDays = {
    SEND_DEMAND: waits.demandDays,
    SEND_BUROFAX: waits.burofaxDays,
    FILE_MONITORIO: waits.monitorioDays,
  }[next];
  const earliest = addDays(last.on, waitDays);
  const verb = TO_DO[next];
  const reason =
    diffDays(today, last.on) >= waitDays
      ? `Ya puedes ${verb}: registraste ${done} el ${formatDate(last.on)} y han pasado los ${String(waitDays)} días de espera sugeridos. ${HEURISTIC}`
      : `Aún es pronto para ${verb}: registraste ${done} el ${formatDate(last.on)} y se sugiere esperar ${String(waitDays)} días, hasta el ${formatDate(earliest)}. ${HEURISTIC}`;
  return {
    action: next,
    reason,
    earliest_on: earliest,
    wait_days: waitDays,
    warnings: limitationWarnings(today, claim),
  };
}
