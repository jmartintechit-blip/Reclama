import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import {
  COMPENSATION_OPTIONS,
  CompensationOption,
} from '../components/CompensationChoices.tsx';
import {
  ErrorSummary,
  TextAreaField,
  TextField,
} from '../components/Field.tsx';
import { api } from '../lib/api.ts';
import {
  errorsFromFailure,
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import {
  useSession,
  type Compensation,
  type Profile as ProfileData,
} from '../lib/session.tsx';

const LABELS = {
  business_name: 'Nombre o razón social',
  tax_id: 'NIF/CIF',
  address: 'Dirección',
  iban: 'IBAN',
  password: 'Contraseña',
};
const PROFILE_FIELDS = ['business_name', 'tax_id', 'address', 'iban'] as const;

interface FormState {
  business_name: string;
  tax_id: string;
  address: string;
  iban: string;
  default_compensation: Compensation;
}

// "ES9121000418450200051332" -> "ES91 2100 0418 4502 0005 1332", easier to check by eye. What is
// sent is whatever the person typed: the server drops the spaces itself.
const groupIban = (iban: string) => iban.replace(/(.{4})(?=.)/g, '$1 ');

function toForm(profile: ProfileData | null): FormState {
  return {
    business_name: profile?.business_name ?? '',
    tax_id: profile?.tax_id ?? '',
    address: profile?.address ?? '',
    iban: groupIban(profile?.iban ?? ''),
    default_compensation: profile?.default_compensation ?? 'PER_CLAIM',
  };
}

// An empty text field clears the stored value (the API takes null for that).
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

function ProfileForm() {
  const { profile, refresh } = useSession();
  const { busy, run } = useBusy();
  // Filled once from the session. It is not re-synced afterwards: a refresh must never
  // overwrite what the person is typing, and a failed save must not lose it.
  const [values, setValues] = useState(() => toForm(profile));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saved, setSaved] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const legend = useId();
  useFocusOnErrors(errors, form);

  const set =
    (name: keyof FormState) => (event: { target: { value: string } }) => {
      setValues((previous) => ({ ...previous, [name]: event.target.value }));
    };

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      setSaved(false);
      setErrors(NO_ERRORS);
      const result = await api<{ profile: ProfileData }>(
        'PATCH',
        '/api/me/profile',
        {
          business_name: orNull(values.business_name),
          tax_id: orNull(values.tax_id),
          address: orNull(values.address),
          iban: orNull(values.iban),
          default_compensation: values.default_compensation,
        },
      );
      if (!result.ok) {
        setErrors(errorsFromFailure(result, PROFILE_FIELDS));
        return;
      }
      setValues(toForm(result.data.profile));
      setSaved(true);
      void refresh();
    });
  }

  return (
    <form
      ref={form}
      className="sheet form"
      noValidate
      aria-busy={busy}
      onSubmit={submit}
    >
      <ErrorSummary errors={errors} labels={LABELS} />
      <TextField
        label="Nombre o razón social"
        name="business_name"
        autoComplete="organization"
        value={values.business_name}
        onChange={set('business_name')}
        error={errors.fields.business_name}
      />
      <TextField
        label="NIF/CIF"
        name="tax_id"
        autoComplete="off"
        value={values.tax_id}
        onChange={set('tax_id')}
        error={errors.fields.tax_id}
      />
      <TextAreaField
        label="Dirección"
        name="address"
        rows={6}
        autoComplete="street-address"
        hint="Aparece en el requerimiento. Máximo 6 líneas."
        value={values.address}
        onChange={set('address')}
        error={errors.fields.address}
      />
      <TextField
        label="IBAN (opcional)"
        name="iban"
        autoComplete="off"
        spellCheck={false}
        hint="La cuenta donde quieres cobrar. Se incluye en el requerimiento."
        value={values.iban}
        onChange={set('iban')}
        error={errors.fields.iban}
      />

      <fieldset className="field" aria-labelledby={legend}>
        <legend id={legend}>Compensación por costes de cobro</legend>
        <p className="hint">
          La jurisprudencia sobre los 40 € no es uniforme, por eso puedes elegir
          cómo se aplican.
        </p>
        {COMPENSATION_OPTIONS.map((option) => (
          <CompensationOption
            key={option.value}
            name="default_compensation"
            option={option}
            checked={values.default_compensation === option.value}
            onSelect={() => {
              setValues((previous) => ({
                ...previous,
                default_compensation: option.value,
              }));
            }}
          />
        ))}
      </fieldset>

      <div role="status" className="form-ok">
        {saved ? <p>Perfil guardado.</p> : null}
      </div>
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar perfil'}
      </button>
    </form>
  );
}

function DeleteAccount() {
  const { forget } = useSession();
  const { busy, run } = useBusy();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const firstOpen = useRef(true);
  useFocusOnErrors(errors, form);

  // Opening the confirmation puts the cursor in the password; closing it gives focus back to the
  // button that opened it, so the keyboard never lands on a control that disappeared.
  useEffect(() => {
    if (firstOpen.current) {
      firstOpen.current = false;
      return;
    }
    if (confirming) {
      form.current?.querySelector('input')?.focus();
    } else {
      opener.current?.focus();
    }
  }, [confirming]);

  function cancel() {
    setConfirming(false);
    setPassword('');
    setErrors(NO_ERRORS);
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      if (password === '') {
        setErrors(withFieldErrors({ password: 'Escribe tu contraseña.' }));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api('DELETE', '/api/me', { password });
      if (!result.ok) {
        if (result.code === 'INVALID_CREDENTIALS') {
          setErrors(
            withFieldErrors({ password: 'La contraseña no es correcta.' }),
          );
        } else if (result.code === 'DEMO_ACCOUNT') {
          setErrors({
            summary:
              'En la demo no se puede borrar la cuenta: caduca sola a las 24 horas.',
            fields: {},
          });
        } else {
          setErrors(errorsFromFailure(result, ['password']));
        }
        return;
      }
      // The server ended the session. Forgetting it here makes this protected page send the
      // visitor home.
      forget();
    });
  }

  return (
    <section className="sheet form" aria-labelledby="borrar-titulo">
      <h2 id="borrar-titulo">Borrar mi cuenta</h2>
      <p>
        Se borra todo: tu perfil, tus facturas, tus deudores y tus
        reclamaciones. No se puede deshacer.
      </p>
      {confirming ? (
        <form ref={form} className="form" noValidate onSubmit={submit}>
          <ErrorSummary errors={errors} labels={LABELS} />
          <TextField
            label="Escribe tu contraseña para confirmar"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            error={errors.fields.password}
          />
          <div className="actions">
            <button type="submit" className="btn danger" disabled={busy}>
              {busy ? 'Borrando…' : 'Sí, borrar todo'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={cancel}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button
            ref={opener}
            type="button"
            className="btn danger-outline"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Borrar mi cuenta
          </button>
        </div>
      )}
    </section>
  );
}

export function Profile() {
  const { user } = useSession();
  return (
    <div className="wrap form-page wide">
      <title>Perfil · Reclama</title>
      <h1>Perfil</h1>
      <p className="lede">
        Estos datos salen en el requerimiento que envías al deudor.
      </p>
      <ProfileForm />
      {user?.is_demo ? (
        <section className="sheet form" aria-labelledby="borrar-titulo">
          <h2 id="borrar-titulo">Borrar mi cuenta</h2>
          <p>
            En la demo no se puede borrar la cuenta: caduca sola a las 24 horas.
          </p>
        </section>
      ) : (
        <DeleteAccount />
      )}
    </div>
  );
}
