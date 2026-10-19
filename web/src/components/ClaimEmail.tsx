import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, type Failure } from '../lib/api.ts';
import type { ClaimDetail, Debtor, EmailSent } from '../lib/api-types.ts';
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
import {
  EMAIL_INVALID_MESSAGE,
  emailMessage,
  failureMessage,
} from '../lib/messages.ts';
import { useLoad } from '../lib/use-api.ts';
import { ErrorSummary, TextField } from './Field.tsx';

// The debtor has no address yet: ask for it here, so the person does not have to leave the claim.
function DebtorEmailForm({
  debtorId,
  onSaved,
}: {
  debtorId: string;
  onSaved: () => void;
}) {
  const { busy, run } = useBusy();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const form = useRef<HTMLFormElement>(null);
  useFocusOnErrors(errors, form);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      // Same shape as the server, which has the last word: trimmed and lower-cased.
      const normalized = email.trim().toLowerCase();
      if (
        normalized === '' ||
        normalized.length > EMAIL_MAX_LENGTH ||
        !EMAIL_PATTERN.test(normalized)
      ) {
        setErrors(withFieldErrors({ email: EMAIL_INVALID_MESSAGE }));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api(
        'PATCH',
        `/api/debtors/${encodeURIComponent(debtorId)}`,
        { email: normalized },
      );
      if (!result.ok) {
        setErrors(errorsFromFailure(result, ['email']));
        return;
      }
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
      <p className="note">
        Este deudor no tiene email. Guárdalo para poder enviarle la carta.
      </p>
      {/* Only while there is something to say: the page has several forms, and each would leave an empty alert behind. */}
      {errors.summary === null ? null : (
        <ErrorSummary errors={errors} labels={{ email: 'Email del deudor' }} />
      )}
      <TextField
        label="Email del deudor"
        name="email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
        error={errors.fields.email}
      />
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar'}
      </button>
    </form>
  );
}

function SendResult({ sent }: { sent: EmailSent }) {
  if (sent.mode === 'sandbox') {
    return (
      <div className="notice calm">
        <p>
          <b>Envío de prueba: el deudor no ha recibido nada.</b>
        </p>
        <p>
          El email ha salido hacia una dirección de pruebas
          {sent.would_have_gone_to === null
            ? ''
            : ` (habría ido a ${sent.would_have_gone_to})`}
          . No se ha registrado ningún paso, así que la guía de arriba no ha
          cambiado.
        </p>
      </div>
    );
  }
  return (
    <div className="notice calm">
      <p>
        <b>Carta enviada a {sent.delivered_to}.</b>
      </p>
      <p>
        {sent.event_recorded
          ? 'Hemos registrado el paso «Requerimiento enviado» con la fecha de hoy.'
          : 'No hemos podido registrar el paso: anótalo tú como «Requerimiento enviado» en «Registrar un paso».'}
      </p>
    </div>
  );
}

function SendLetter({
  claimId,
  debtorEmail,
  focusOnMount,
  onRecorded,
}: {
  claimId: string;
  debtorEmail: string;
  focusOnMount: boolean;
  onRecorded: () => void;
}) {
  const { busy, run } = useBusy();
  const [sent, setSent] = useState<EmailSent | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // One key per "attempt to send": a retry after a network error or a 502 (the email may have gone
  // out) repeats it so the server does not send twice; it is renewed once the attempt is settled.
  const key = useRef<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  // The button is disabled while the email is sent, which drops the keyboard focus: give it back.
  useEffect(() => {
    if (wasBusy.current && !busy) button.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    if (focusOnMount) button.current?.focus();
  }, [focusOnMount]);

  function send() {
    void run(async () => {
      setSent(null);
      setFailure(null);
      key.current ??= crypto.randomUUID();
      const result = await api<EmailSent>(
        'POST',
        `/api/claims/${encodeURIComponent(claimId)}/email`,
        undefined,
        { 'Idempotency-Key': key.current },
      );
      if (!result.ok) {
        // 409: that key already sent an email, so pressing again must be a new send.
        if (result.code === 'EMAIL_ALREADY_SENT') key.current = null;
        setFailure(result);
        return;
      }
      key.current = null;
      setSent(result.data);
      if (result.data.event_recorded) onRecorded();
    });
  }

  return (
    <>
      <p className="note">
        En la demo y en el modo de pruebas el email NO sale hacia el deudor: va
        a una dirección de prueba y no se registra ningún paso. Con el envío
        real activado llegaría a {debtorEmail} con la carta en PDF adjunta y
        quedaría registrado el paso «Requerimiento enviado».
      </p>
      <div className="actions claim">
        <button
          ref={button}
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={send}
        >
          {busy ? 'Enviando…' : 'Enviar la carta por email'}
        </button>
      </div>
      <div role="status" className="live">
        {busy ? <p className="note">Enviando el email…</p> : null}
        {sent ? <SendResult sent={sent} /> : null}
      </div>
      {failure ? (
        <div className="notice" role="alert">
          <p>{emailMessage(failure)}</p>
          {failure.code === 'PROFILE_INCOMPLETE' ? (
            <Link className="btn" to="/perfil">
              Completar el perfil
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function ClaimEmail({
  claim,
  onRecorded,
}: {
  claim: ClaimDetail;
  onRecorded: () => void;
}) {
  const url = `/api/debtors/${encodeURIComponent(claim.debtor_id)}`;
  const load = useLoad<{ debtor: Debtor }>(url, () =>
    api<{ debtor: Debtor }>('GET', url),
  );
  // The form disappears once the address is saved: the cursor goes on to the send button.
  const [justSaved, setJustSaved] = useState(false);
  const result = load.result;

  let body;
  if (result === null) {
    body = (
      <p role="status" className="note">
        Cargando los datos del deudor…
      </p>
    );
  } else if (!result.ok) {
    body = (
      <div className="notice" role="alert">
        <p>{failureMessage(result)}</p>
        <button
          type="button"
          className="btn"
          disabled={load.reloading}
          onClick={load.reload}
        >
          Reintentar
        </button>
      </div>
    );
  } else if (result.data.debtor.email === null) {
    body = (
      <DebtorEmailForm
        debtorId={claim.debtor_id}
        onSaved={() => {
          setJustSaved(true);
          load.reload();
        }}
      />
    );
  } else {
    body = (
      <SendLetter
        claimId={claim.id}
        debtorEmail={result.data.debtor.email}
        focusOnMount={justSaved}
        onRecorded={onRecorded}
      />
    );
  }

  return (
    <section className="panel" aria-labelledby="email-titulo">
      <h2 id="email-titulo">Enviar la carta por email</h2>
      {body}
    </section>
  );
}
