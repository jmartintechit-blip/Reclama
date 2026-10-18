// Spanish texts for what the API can answer. The server is the authority: it sends codes and
// field paths (and English rule descriptions meant for developers); this file turns them into
// text for people.
import type { Failure, ValidationDetail } from './api.ts';

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
