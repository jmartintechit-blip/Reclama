import { useId, useRef, useState, type SubmitEvent } from 'react';
import { api } from '../lib/api.ts';
import type { Debtor, DebtorKind } from '../lib/api-types.ts';
import {
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
  errorsFromFailure,
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import { EMAIL_INVALID_MESSAGE } from '../lib/messages.ts';
import { ErrorSummary, TextField } from './Field.tsx';

export const KIND_LABELS: Record<DebtorKind, string> = {
  BUSINESS: 'Empresa o autónomo (B2B)',
  PUBLIC_ADMIN: 'Administración pública',
  CONSUMER: 'Consumidor',
  UNKNOWN: 'Sin clasificar',
};
const KINDS = Object.keys(KIND_LABELS) as DebtorKind[];

const LABELS = { kind: 'Tipo de deudor', email: 'Email' };
const FIELDS = ['kind', 'email'] as const;

function KindOption({
  kind,
  checked,
  onSelect,
}: {
  kind: DebtorKind;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="choice">
      <input
        type="radio"
        name="kind"
        value={kind}
        checked={checked}
        onChange={onSelect}
      />
      <b>{KIND_LABELS[kind]}</b>
    </label>
  );
}

// The form starts from the debtor once. It is not re-synced afterwards, so a reload of the
// page data never overwrites what the person is typing.
function DebtorForm({
  debtor,
  onSaved,
}: {
  debtor: Debtor;
  onSaved: () => void;
}) {
  const { busy, run } = useBusy();
  const [kind, setKind] = useState<DebtorKind>(debtor.kind);
  const [email, setEmail] = useState(debtor.email ?? '');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saved, setSaved] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const legend = useId();
  useFocusOnErrors(errors, form);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      setSaved(false);
      // Same shape as the server: trimmed and lower-cased; an empty field clears the address.
      const normalized = email.trim().toLowerCase();
      if (
        normalized !== '' &&
        (normalized.length > EMAIL_MAX_LENGTH ||
          !EMAIL_PATTERN.test(normalized))
      ) {
        setErrors(withFieldErrors({ email: EMAIL_INVALID_MESSAGE }));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api('PATCH', `/api/debtors/${debtor.id}`, {
        kind,
        email: normalized === '' ? null : normalized,
      });
      if (!result.ok) {
        setErrors(errorsFromFailure(result, FIELDS));
        return;
      }
      setEmail(normalized);
      setSaved(true);
      onSaved();
    });
  }

  return (
    <form
      ref={form}
      className="form"
      noValidate
      aria-busy={busy}
      onSubmit={submit}
    >
      <ErrorSummary errors={errors} labels={LABELS} />
      <fieldset className="field" aria-labelledby={legend}>
        <legend id={legend}>Tipo de deudor</legend>
        <div className="choices">
          {KINDS.map((option) => (
            <KindOption
              key={option}
              kind={option}
              checked={kind === option}
              onSelect={() => {
                setKind(option);
              }}
            />
          ))}
        </div>
        {errors.fields.kind ? (
          <p className="field-error">{errors.fields.kind}</p>
        ) : null}
      </fieldset>
      <TextField
        label="Email del deudor (opcional)"
        name="email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
        error={errors.fields.email}
      />
      <div role="status" className="form-ok">
        {saved ? <p>Deudor guardado.</p> : null}
      </div>
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar deudor'}
      </button>
    </form>
  );
}

export function DebtorSection({
  debtor,
  onSaved,
}: {
  debtor: Debtor;
  onSaved: () => void;
}) {
  return (
    <section className="panel" aria-labelledby="deudor-titulo">
      <h2 id="deudor-titulo">Deudor</h2>
      <dl className="debtor-facts">
        <div>
          <dt>Nombre</dt>
          <dd>{debtor.name}</dd>
        </div>
        <div>
          <dt>NIF</dt>
          <dd>{debtor.tax_id ?? 'Sin NIF'}</dd>
        </div>
      </dl>
      <p className="note">
        Reclama solo reclama intereses a empresas y autónomos: los consumidores
        quedan fuera de esta ley y las administraciones públicas no se tramitan
        aquí. Un deudor «Sin clasificar» hay que marcarlo como empresa o
        autónomo antes de reclamar.
      </p>
      <DebtorForm key={debtor.id} debtor={debtor} onSaved={onSaved} />
    </section>
  );
}
