// Shared plumbing for the forms: error shape, double-submit lock, focus on failure and the
// "where to go after signing in" rule.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Failure } from './api.ts';
import {
  CHECK_DATA_MESSAGE,
  failureMessage,
  fieldMessage,
} from './messages.ts';

// The server's email rule, copied to tell the person at once: lower-case ASCII shape after
// trimming, at most 254 characters.
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface FormErrors {
  // A message about the whole form (wrong credentials, no connection...).
  summary: string | null;
  // Field name -> message.
  fields: Record<string, string>;
}

export const NO_ERRORS: FormErrors = { summary: null, fields: {} };

export function withFieldErrors(fields: Record<string, string>): FormErrors {
  return {
    summary: Object.keys(fields).length > 0 ? CHECK_DATA_MESSAGE : null,
    fields,
  };
}

// A failed call -> what to show. `known` lists the field names of the form: a validation detail
// about any other path (or about the whole body) cannot be pinned to a field, so only the
// summary mentions it instead of it being lost.
export function errorsFromFailure(
  failure: Failure,
  known: readonly string[],
): FormErrors {
  if (failure.kind !== 'validation' || !failure.details?.length) {
    return { summary: failureMessage(failure), fields: {} };
  }
  const fields: Record<string, string> = {};
  for (const detail of failure.details) {
    if (known.includes(detail.path)) {
      fields[detail.path] ??= fieldMessage(detail);
    }
  }
  return { summary: CHECK_DATA_MESSAGE, fields };
}

// Runs one task at a time. The lock is a ref, not the `busy` state, because two submits in the
// same tick (Enter twice) both see the old state; the state only drives what is drawn.
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const run = useCallback(async (task: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

// After a failed submit, focus goes to the first invalid field (its message is read with it
// through aria-describedby), or to the summary when no field is to blame. It runs whenever
// `errors` is a new object, so set it on submit only, never while the person is typing.
export function useFocusOnErrors(
  errors: FormErrors,
  root: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (errors.summary === null && Object.keys(errors.fields).length === 0) {
      return;
    }
    const target =
      root.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      root.current?.querySelector<HTMLElement>('[data-error-summary]');
    target?.focus();
  }, [errors, root]);
}

// The path remembered by RequireAuth, kept in the router state (never in the URL). It is only
// followed only when it resolves to this app's own origin: one slash, not "//host", and no tab or
// newline (browsers strip them, so "/	/host" would become "//host").
export function rememberedPath(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) {
    return null;
  }
  const from = state.from;
  if (typeof from !== 'string' || !from.startsWith('/')) return null;
  try {
    return new URL(from, window.location.origin).origin ===
      window.location.origin
      ? from
      : null;
  } catch {
    return null;
  }
}
