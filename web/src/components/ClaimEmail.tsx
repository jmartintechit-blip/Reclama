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

// One key per attempt to send, kept in sessionStorage (not only in memory) so a reload while the
// email is in flight repeats the key and the server cannot send twice. It is dropped once the
// attempt has an answer that settles it (sent, or "already sent"). Without storage it still works
// for the life of the page.
const keyName = (claimId: string) => `reclama:email-key:${claimId}`;
const memoryKeys = new Map<string, string>();

function takeKey(claimId: string): string {
  const name = keyName(claimId);
  try {
    const stored = sessionStorage.getItem(name);
    if (stored !== null) return stored;
  } catch {
    // storage blocked: fall through to the in-memory key
  }
  const key = memoryKeys.get(name) ?? crypto.randomUUID();
  memoryKeys.set(name, key);
  try {
    sessionStorage.setItem(name, key);
  } catch {
    // storage blocked: the in-memory key is all there is
  }
  return key;
}

function dropKey(claimId: string): void {
  const name = keyName(claimId);
  memoryKeys.delete(name);
  try {
    sessionStorage.removeItem(name);
  } catch {
    // nothing to remove
  }
}

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
  demandSentBefore,
  focusOnMount,
  onRecorded,
}: {
  claimId: string;
  debtorEmail: string;
  // The claim already has a recorded "Requerimiento enviado": a second email needs a second yes.
  demandSentBefore: boolean;
  focusOnMount: boolean;
  onRecorded: () => void;
}) {
  const { busy, run } = useBusy();
  const [sent, setSent] = useState<EmailSent | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const again = demandSentBefore || sent?.mode === 'live';
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
      setConfirming(false);
      const result = await api<EmailSent>(
        'POST',
        `/api/claims/${encodeURIComponent(claimId)}/email`,
        undefined,
        { 'Idempotency-Key': takeKey(claimId) },
      );
      if (!result.ok) {
        // 409: that key already sent an email, so pressing again must be a new send.
        if (result.code === 'EMAIL_ALREADY_SENT') dropKey(claimId);
        setFailure(result);
        return;
      }
      dropKey(claimId);
      setSent(result.data);
      if (result.data.event_recorded) onRecorded();
    });
  }

  return (
    <>
      <p className="note">
        En la demo y en el modo de pruebas el email NO sale hacia el deudor:
        como mucho llega a una dirección de pruebas y no se registra ningún
        paso. Con el envío real activado llegaría a {debtorEmail} con la carta
        en PDF adjunta y quedaría registrado el paso «Requerimiento enviado».
      </p>
      <div className="actions claim">
        <button
          ref={button}
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={
            again
              ? () => {
                  setConfirming(true);
                }
              : send
          }
        >
          {busy
            ? 'Enviando…'
            : again
              ? 'Enviar otra vez'
              : 'Enviar la carta por email'}
        </button>
      </div>
      {confirming && !busy ? (
        <div className="notice" role="group" aria-labelledby="reenviar-titulo">
          <p id="reenviar-titulo">
            <b>¿Enviar el requerimiento otra vez?</b>
          </p>
          <p>
            Esta reclamación ya tiene un requerimiento enviado. Si lo envías de
            nuevo, el deudor recibirá un segundo correo con la carta.
          </p>
          <div className="actions">
            <button type="button" className="btn danger" onClick={send}>
              Sí, enviar otra vez
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirming(false);
              }}
            >
              No, no enviar
            </button>
          </div>
        </div>
      ) : null}
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
        demandSentBefore={claim.events.some(
          (event) => event.kind === 'DEMAND_SENT',
        )}
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
