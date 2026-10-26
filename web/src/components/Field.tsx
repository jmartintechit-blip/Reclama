import { useId, type ComponentProps, type ReactNode } from 'react';
import type { FormErrors } from '../lib/forms.ts';

interface FieldBase {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

function describedBy(
  id: string,
  hint: ReactNode,
  error: string | undefined,
): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(
    Boolean,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Shell({
  id,
  label,
  hint,
  error,
  children,
}: FieldBase & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  ...input
}: FieldBase & Omit<ComponentProps<'input'>, 'id' | 'aria-describedby'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input
        {...input}
        id={id}
        className="input"
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
      />
    </Shell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  ...input
}: FieldBase & Omit<ComponentProps<'textarea'>, 'id' | 'aria-describedby'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <textarea
        {...input}
        id={id}
        className="input"
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
      />
    </Shell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...input
}: FieldBase & Omit<ComponentProps<'select'>, 'id' | 'aria-describedby'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select
        {...input}
        id={id}
        className="input"
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
      >
        {children}
      </select>
    </Shell>
  );
}

// The form-level message. The region exists even when empty: a live region that is added to the
// page together with its text is announced less reliably than one whose text changes.
export function ErrorSummary({
  errors,
  labels,
}: {
  errors: FormErrors;
  labels: Record<string, string>;
}) {
  const entries = Object.entries(errors.fields);
  return (
    <div role="alert" className="form-alert" tabIndex={-1} data-error-summary>
      {errors.summary ? <p>{errors.summary}</p> : null}
      {entries.length > 0 ? (
        <ul>
          {entries.map(([name, message]) => (
            <li key={name}>
              {labels[name] ?? name}: {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
