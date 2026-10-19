// A small fetch wrapper for the same-origin JSON API. It never throws: every outcome, including
// a dead network, an empty 429 from the CDN edge or an HTML 502, comes back as a value, so a
// screen handles one result type instead of try/catch plus status checks.

export type FailureKind =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'network'
  | 'server';

export interface ValidationDetail {
  path: string;
  message: string;
}

export interface Failure {
  ok: false;
  kind: FailureKind;
  // 0 when no HTTP answer arrived (network).
  status: number;
  // The server's error code (INVALID_CREDENTIALS...), when the body had one.
  code?: string;
  details?: ValidationDetail[];
  // Business errors carry their figures here as an object (remaining_cents, missing_semesters).
  extra?: Record<string, unknown>;
  // Seconds to wait, from the Retry-After header.
  retryAfter?: number;
}

export type ApiResult<T> = { ok: true; data: T } | Failure;

function kindOf(status: number): FailureKind {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'unavailable';
    default:
      // 500, and the 4xx the app never provokes on purpose (413, 415...).
      return 'server';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Retry-After is either a number of seconds or an HTTP date.
function parseRetryAfter(value: string | null): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function readDetails(value: unknown): ValidationDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details: ValidationDetail[] = [];
  for (const item of value) {
    if (
      isRecord(item) &&
      typeof item.path === 'string' &&
      typeof item.message === 'string'
    ) {
      details.push({ path: item.path, message: item.message });
    }
  }
  return details;
}

// A 401 with this code means "your session is gone". Other 401s (wrong password) do not.
const SESSION_GONE_CODE = 'UNAUTHENTICATED';

const expiredListeners = new Set<() => void>();

// The session state subscribes here, so any call that finds the session gone flips the app to
// anonymous without every screen having to remember to check. Returns the unsubscribe function.
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => {
    expiredListeners.delete(listener);
  };
}

function fail(
  kind: FailureKind,
  status: number,
  extra: Partial<Failure> = {},
): Failure {
  return { ok: false, kind, status, ...extra };
}

export async function api<T = void>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    return fail('network', 0);
  }

  let json: unknown;
  let parsed = true;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

  if (response.ok) {
    if (text === '') return { ok: true, data: undefined as T };
    // A 2xx that is not the API's envelope (typically the app's HTML served for a missing
    // function) must not be taken for data.
    if (!parsed || !isRecord(json) || !('data' in json)) {
      return fail('server', response.status);
    }
    return { ok: true, data: json.data as T };
  }

  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  const failure = fail(kindOf(response.status), response.status, {
    code: typeof error.code === 'string' ? error.code : undefined,
    details: readDetails(error.details),
    extra: isRecord(error.details) ? error.details : undefined,
    retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
  });
  if (failure.code === SESSION_GONE_CODE) {
    for (const listener of expiredListeners) listener();
  }
  return failure;
}
