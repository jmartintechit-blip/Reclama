// Spanish texts for what the API can answer. The server is the authority: it sends codes and
// field paths (and English rule descriptions meant for developers); this file turns them into
// text for people.
import type { Failure, ValidationDetail } from './api.ts';
import { MAX_INVOICES_PER_CLAIM } from './claims.ts';
import { formatSemesterList } from './format.ts';

export const NETWORK_MESSAGE =
  'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.';
export const SERVER_MESSAGE =
  'Algo ha fallado de nuestro lado. Inténtalo de nuevo en unos minutos.';
export const CHECK_DATA_MESSAGE = 'Revisa los datos e inténtalo de nuevo.';

// 90 -> "2 minutos"; the wait is rounded up so nobody retries a few seconds too early.
function formatWait(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return `${String(s)} ${s === 1 ? 'segundo' : 'segundos'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) {
    return `${String(minutes)} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `${String(hours)} horas`;
}

export function rateLimitedMessage(retryAfter?: number): string {
  return retryAfter === undefined
    ? 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.'
    : `Demasiados intentos. Espera ${formatWait(retryAfter)} y vuelve a intentarlo.`;
}

// The text for a failure that has no screen-specific meaning.
export function failureMessage(failure: Failure): string {
  switch (failure.kind) {
    case 'rate_limited':
      return rateLimitedMessage(failure.retryAfter);
    case 'network':
      return NETWORK_MESSAGE;
    case 'unauthenticated':
      return 'Tu sesión ha caducado. Entra de nuevo.';
    case 'forbidden':
      return 'No tienes permiso para hacer esto.';
    case 'not_found':
      return 'No hemos encontrado lo que buscabas.';
    case 'conflict':
      return 'Esto choca con datos que ya existen.';
    case 'validation':
      return CHECK_DATA_MESSAGE;
    case 'server':
    case 'unavailable':
      return SERVER_MESSAGE;
  }
}

export const EMAIL_INVALID_MESSAGE =
  'Escribe un email válido, por ejemplo nombre@empresa.es.';
export const PASSWORD_TOO_SHORT_MESSAGE =
  'La contraseña necesita al menos 10 caracteres.';
export const PASSWORD_TOO_LONG_MESSAGE =
  'La contraseña admite como máximo 128 caracteres.';

const MAX_LENGTHS: Record<string, number> = {
  business_name: 200,
  tax_id: 30,
  address: 500,
  iban: 64,
  note: 1000,
};

// One validation detail -> Spanish text for its field. The match is on the rule the server
// described, falling back to a generic text per field, so a rule added later still shows
// something sensible instead of English.
export function fieldMessage({ path, message }: ValidationDetail): string {
  if (message.includes('control characters')) {
    return 'Este campo contiene caracteres que no se admiten.';
  }
  switch (path) {
    case 'email':
      return EMAIL_INVALID_MESSAGE;
    case 'password':
      if (message.includes('at least')) return PASSWORD_TOO_SHORT_MESSAGE;
      if (message.includes('at most')) return PASSWORD_TOO_LONG_MESSAGE;
      return 'La contraseña contiene caracteres que no se admiten.';
    case 'iban':
      return message.includes('valid IBAN')
        ? 'Este IBAN no es válido. Revísalo: los espacios no importan.'
        : 'El IBAN es demasiado largo.';
    case 'address':
      if (message.includes('lines')) {
        return 'La dirección admite como máximo 6 líneas.';
      }
      break;
    default:
      break;
  }
  const max = MAX_LENGTHS[path];
  if (max !== undefined && /(<=|at most|too big)/i.test(message)) {
    return `Este campo admite como máximo ${String(max)} caracteres.`;
  }
  return 'Revisa este campo.';
}

// What POST /api/claims can answer, in words. Anything without its own text falls back to the
// generic failure text; a validation error with field details is left to the form.
export function createClaimMessage(failure: Failure): string | null {
  switch (failure.code) {
    case 'DEBTOR_NOT_B2B':
      return 'Reclama solo reclama a empresas y autónomos: la ley de morosidad no cubre a los consumidores y las administraciones públicas siguen otras reglas.';
    case 'DEBTOR_KIND_UNKNOWN':
    case 'DEBTOR_KIND_UNCONFIRMED':
      return 'Marca primero al deudor como empresa o autónomo. Se hace desde la pantalla de una de sus facturas.';
    case 'NOT_OVERDUE':
      return 'Ninguna de las facturas elegidas estaba vencida en la fecha de cálculo. Elige otra fecha u otras facturas.';
    case 'RATE_WINDOW':
      return `No podemos calcular los intereses de estas facturas: faltan los tipos de demora del BOE de ${formatSemesterList(failure.extra?.missing_semesters)}. Reclama no extrapola ni estima tipos.`;
    case 'AS_OF_IN_FUTURE':
      return 'La fecha de cálculo no puede ser futura.';
    case 'CLAIM_TOO_LARGE': {
      const limit =
        typeof failure.extra?.limit === 'number'
          ? failure.extra.limit
          : MAX_INVOICES_PER_CLAIM;
      return `Una reclamación admite como máximo ${String(limit)} facturas. Elige algunas y reclama el resto en una segunda reclamación.`;
    }
    case 'INVOICE_IN_CLAIM':
      return 'Alguna de las facturas elegidas ya está en otra reclamación. Cancela esa reclamación o quita la factura de la selección.';
    case 'INVOICE_NOT_OPEN':
      return 'Alguna de las facturas elegidas ya está cobrada o no está abierta. Recarga la página para ver cómo están ahora.';
    case 'CLAIM_LIMIT_REACHED':
      return 'Has llegado al máximo de reclamaciones de la cuenta. Cancela alguna que ya no necesites.';
    case 'CALCULATION_FAILED':
      return 'No hemos podido calcular los intereses de estas facturas. Revisa sus fechas y sus cobros.';
    default:
      break;
  }
  if (failure.kind === 'not_found') {
    return 'No encontramos el deudor o alguna de las facturas. Puede que se hayan borrado: recarga la página.';
  }
  return failure.kind === 'validation' && failure.details?.length
    ? null
    : failureMessage(failure);
}

const PROFILE_FIELD_NAMES: Record<string, string> = {
  business_name: 'nombre o razón social',
  tax_id: 'NIF/CIF',
  address: 'dirección',
  iban: 'IBAN válido',
};

// What GET /api/claims/:id/letter.pdf can answer, in words.
export function letterMessage(failure: Failure): string {
  switch (failure.code) {
    case 'PROFILE_INCOMPLETE': {
      const missing = (failure.details ?? [])
        .map((detail) => PROFILE_FIELD_NAMES[detail.path])
        .filter((name): name is string => name !== undefined);
      return missing.length > 0
        ? `Para generar la carta faltan datos en tu perfil: ${missing.join(', ')}.`
        : 'Para generar la carta completa los datos de tu negocio en el perfil.';
    }
    case 'CLAIM_NOT_ACTIONABLE':
      switch (failure.extra?.reason) {
        case 'invoice_changed':
          return 'Una de las facturas ha cambiado desde que creaste esta reclamación (por ejemplo, has registrado un cobro), así que las cifras de la carta ya no son correctas. Cancela esta reclamación y crea otra con las cifras actualizadas.';
        case 'invoice_paid':
          return 'Una de las facturas se ha cobrado por completo desde que creaste la reclamación, así que ya no hay nada que reclamar. Puedes cancelarla.';
        case 'marked_paid':
          return 'La reclamación está marcada como cobrada, así que no se puede generar la carta.';
        case 'debtor_not_business':
          return 'El deudor ya no está marcado como empresa o autónomo, así que no se puede generar la carta. Revisa su tipo en la pantalla de una de sus facturas.';
        default:
          return 'Ya no se puede generar la carta de esta reclamación porque sus datos han cambiado. Cancélala y crea otra.';
      }
    case 'LETTER_NOT_AVAILABLE':
      return 'No hemos podido generar la carta de esta reclamación.';
    default:
      return failure.kind === 'not_found'
        ? 'Esta reclamación ya no existe.'
        : failureMessage(failure);
  }
}

// What POST /api/claims/:id/events can answer, in words; null for a validation error with field
// details, which is left to the form.
export function eventMessage(failure: Failure): string | null {
  switch (failure.code) {
    case 'EVENT_IN_FUTURE':
      return 'La fecha del paso no puede ser futura.';
    case 'EVENT_BEFORE_CLAIM':
      return 'La fecha del paso no puede ser anterior a la fecha de cálculo de la reclamación.';
    case 'EVENT_LIMIT_REACHED': {
      const limit = failure.extra?.limit;
      return `Esta reclamación ya tiene el máximo de pasos registrados${typeof limit === 'number' ? ` (${String(limit)})` : ''}.`;
    }
    default:
      if (failure.kind === 'not_found') return 'Esta reclamación ya no existe.';
      return failure.kind === 'validation' && failure.details?.length
        ? null
        : failureMessage(failure);
  }
}

// What POST /api/claims/:id/email can answer, in words. The profile, letter and "claim can no
// longer be demanded" errors read the same as for the PDF download.
export function emailMessage(failure: Failure): string {
  if (failure.kind === 'rate_limited') {
    return `Has llegado al límite de envíos por email. ${rateLimitedMessage(failure.retryAfter)}`;
  }
  switch (failure.code) {
    case 'EMAIL_ALREADY_SENT':
      return 'Este envío ya se había hecho: el intento anterior sí llegó a salir. Si quieres mandar otro email, vuelve a pulsar el botón.';
    case 'DEBTOR_EMAIL_MISSING':
      return 'El deudor no tiene email. Guárdalo y vuelve a intentarlo.';
    case 'EMAIL_NOT_CONFIGURED':
      return 'El envío por email no está disponible en este servidor.';
    case 'EMAIL_PROVIDER_ERROR':
      return failure.extra?.reason === 'rejected' ||
        failure.extra?.reason === 'invalid'
        ? 'El servicio de correo ha rechazado el mensaje. Revisa el email del deudor e inténtalo de nuevo.'
        : 'El servicio de correo no ha podido enviar el mensaje ahora mismo. Vuelve a pulsar el botón en unos minutos: se reutiliza el mismo intento, así que no se envía dos veces.';
    default:
      return letterMessage(failure);
  }
}
