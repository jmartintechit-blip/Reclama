import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { api, type Failure } from '../lib/api.ts';
import type { ClaimDetail, ClaimEventKind } from '../lib/api-types.ts';
import { EVENT_LABELS } from '../lib/claims.ts';
import { formatDate } from '../lib/format.ts';
import {
  errorsFromFailure,
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import { eventMessage } from '../lib/messages.ts';
import { ErrorSummary, TextField } from './Field.tsx';

// Mirrors the API: the longest note a step can have.
const NOTE_MAX_LENGTH = 1000;

const LABELS = {
  kind: 'Tipo de paso',
  occurred_on: 'Fecha del paso',
  note: 'Nota',
};
const FIELDS = ['kind', 'occurred_on', 'note'] as const;
const KINDS = Object.keys(EVENT_LABELS) as ClaimEventKind[];

function stepErrors(failure: Failure): FormErrors {
  const text = eventMessage(failure);
  if (text === null) return errorsFromFailure(failure, FIELDS);
  return failure.code === 'EVENT_IN_FUTURE' ||
    failure.code === 'EVENT_BEFORE_CLAIM'
    ? withFieldErrors({ occurred_on: text })
    : { summary: text, fields: {} };
}

function StepForm({
  claim,
  today,
  onRecorded,
}: {
  claim: ClaimDetail;
  today: string;
  onRecorded: () => void;
}) {
  const { busy, run } = useBusy();
  const [kind, setKind] = useState<ClaimEventKind | ''>('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saved, setSaved] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);
  const giveFocusBack = useRef(false);
  const kindId = useId();
  useFocusOnErrors(errors, form);

  // The button is disabled while the step is sent, which drops the keyboard focus: after a
  // recorded step it goes back to the button (a failure puts it on the field to fix instead).
  useEffect(() => {
    if (wasBusy.current && !busy && giveFocusBack.current) {
      giveFocusBack.current = false;
      button.current?.focus();
    }
    wasBusy.current = busy;
  }, [busy]);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      setSaved(false);
      const fields: Record<string, string> = {};
      if (kind === '') fields.kind = 'Elige el tipo de paso.';
      if (date === '') fields.occurred_on = 'Elige la fecha del paso.';
      else if (date > today) {
        fields.occurred_on = 'La fecha del paso no puede ser futura.';
      } else if (date < claim.as_of) {
        fields.occurred_on = `La fecha del paso no puede ser anterior al ${formatDate(claim.as_of)}, cuando se calculó la reclamación.`;
      }
      if (kind === '' || Object.keys(fields).length > 0) {
        setErrors(withFieldErrors(fields));
        return;
      }
      setErrors(NO_ERRORS);
      const trimmed = note.trim();
      const result = await api('POST', `/api/claims/${claim.id}/events`, {
        kind,
        occurred_on: date,
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
      if (!result.ok) {
        setErrors(stepErrors(result));
        return;
      }
      setKind('');
      setDate(today);
      setNote('');
      setSaved(true);
      giveFocusBack.current = true;
      onRecorded();
    });
  }

  return (
    <form
      ref={form}
      className="form pay-form"
      noValidate
      aria-busy={busy}
      aria-labelledby="registrar-titulo"
      onSubmit={submit}
    >
      <h3 id="registrar-titulo">Registrar un paso</h3>
      <p className="hint">
        Anota aquí lo que ya has hecho fuera de Reclama: la guía de arriba
        avanza con lo que registres.
      </p>
      {/* Only while there is something to say: the page has several forms, and each would leave an empty alert behind. */}
      {errors.summary === null ? null : (
        <ErrorSummary errors={errors} labels={LABELS} />
      )}
      <div className="field">
        <label htmlFor={kindId}>Tipo de paso</label>
        <select
          id={kindId}
          name="kind"
          className="input"
          aria-describedby={errors.fields.kind ? `${kindId}-error` : undefined}
          aria-invalid={errors.fields.kind ? true : undefined}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ClaimEventKind | '');
          }}
        >
          <option value="">Elige el tipo de paso</option>
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {EVENT_LABELS[option]}
            </option>
          ))}
        </select>
        {errors.fields.kind ? (
          <p id={`${kindId}-error`} className="field-error">
            {errors.fields.kind}
          </p>
        ) : null}
      </div>
      <div className="pay-fields">
        <TextField
          label="Fecha del paso"
          name="occurred_on"
          type="date"
          min={claim.as_of}
          max={today}
          hint="Desde el cálculo de la reclamación hasta hoy."
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
          error={errors.fields.occurred_on}
        />
        <TextField
          label="Nota (opcional)"
          name="note"
          autoComplete="off"
          maxLength={NOTE_MAX_LENGTH}
          hint={`Una línea, hasta ${String(NOTE_MAX_LENGTH)} caracteres.`}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          error={errors.fields.note}
        />
      </div>
      <div role="status" className="form-ok">
        {saved ? <p>Paso registrado.</p> : null}
      </div>
      <button
        ref={button}
        type="submit"
        className="btn primary"
        disabled={busy}
      >
        {busy ? 'Guardando…' : 'Registrar paso'}
      </button>
    </form>
  );
}

// What has been done so far, oldest first as the server sends it, and the form to add a step.
export function ClaimSteps({
  claim,
  today,
  onRecorded,
}: {
  claim: ClaimDetail;
  today: string;
  onRecorded: () => void;
}) {
  return (
    <section className="panel" aria-labelledby="pasos-titulo">
      <h2 id="pasos-titulo">Pasos registrados</h2>
      {claim.events.length === 0 ? (
        <p className="note">Aún no has registrado ningún paso.</p>
      ) : (
        <ol className="event-list" aria-labelledby="pasos-titulo">
          {claim.events.map((event) => (
            <li key={event.id}>
              <b>{EVENT_LABELS[event.kind]}</b>
              <time dateTime={event.occurred_on}>
                {formatDate(event.occurred_on)}
              </time>
              {event.note === null ? null : (
                <span className="event-note">{event.note}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <StepForm claim={claim} today={today} onRecorded={onRecorded} />
    </section>
  );
}
