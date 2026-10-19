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

// The failure for a non-2xx answer whose body has already been read. A 401 that says the session
// is gone is announced here, so every call (JSON or file) flips the app to anonymous.
function failureOf(response: Response, json: unknown): Failure {
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

// Not JSON (an empty 429 from the edge, an HTML 502): `parsed` is false and `json` undefined.
function parseJson(text: string): { json: unknown; parsed: boolean } {
  if (text === '') return { json: undefined, parsed: true };
  try {
    return { json: JSON.parse(text) as unknown, parsed: true };
  } catch {
    return { json: undefined, parsed: false };
  }
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

  const { json, parsed } = parseJson(text);

  if (response.ok) {
    if (text === '') return { ok: true, data: undefined as T };
    // A 2xx that is not the API's envelope (typically the app's HTML served for a missing
    // function) must not be taken for data.
    if (!parsed || !isRecord(json) || !('data' in json)) {
      return fail('server', response.status);
    }
    return { ok: true, data: json.data as T };
  }

  return failureOf(response, json);
}

// A GET that answers a file (the letter PDF) instead of JSON. The content type is checked before
// the body is taken for the file: a 200 with the app's HTML page must not be saved as a PDF.
// Errors are the API's usual JSON, so the screen reads them like any other failure.
export async function apiFile(
  path: string,
  contentType: string,
): Promise<ApiResult<{ blob: Blob; filename: string | null }>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: `${contentType}, application/json` },
    });
    if (response.ok) {
      const type = response.headers.get('Content-Type') ?? '';
      if (!type.toLowerCase().startsWith(contentType)) {
        return fail('server', response.status);
      }
      return {
        ok: true,
        data: {
          blob: await response.blob(),
          filename: filenameOf(response.headers.get('Content-Disposition')),
        },
      };
    }
    return failureOf(response, parseJson(await response.text()).json);
  } catch {
    return fail('network', 0);
  }
}

// Only a plain name is trusted (letters, digits, dots, hyphens): whatever else the header says,
// the caller falls back to its own name.
function filenameOf(disposition: string | null): string | null {
  const match = /filename="([A-Za-z0-9][A-Za-z0-9._-]{0,100})"/.exec(
    disposition ?? '',
  );
  return match?.[1] ?? null;
}
