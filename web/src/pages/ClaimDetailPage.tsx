import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ClaimFrame,
  ClaimLoadError,
  ClaimLoading,
} from '../components/ClaimFrame.tsx';
import { api, apiFile, type Failure } from '../lib/api.ts';
import type { ClaimDetail } from '../lib/api-types.ts';
import { COMPENSATION_LABELS, saveFile } from '../lib/claims.ts';
import { formatDate, formatEUR, formatRate } from '../lib/format.ts';
import { useBusy } from '../lib/forms.ts';
import { failureMessage, letterMessage } from '../lib/messages.ts';
import { useLoad } from '../lib/use-api.ts';

const BACK = { to: '/reclamaciones', label: 'Ver todas las reclamaciones' };

function Facts({ claim }: { claim: ClaimDetail }) {
  return (
    <dl className="facts">
      <div>
        <dt>Principal</dt>
        <dd className="amt">{formatEUR(claim.principal_cents)}</dd>
        <small>
          {String(claim.lines.length)}{' '}
          {claim.lines.length === 1 ? 'factura' : 'facturas'}
        </small>
      </div>
      <div>
        <dt>Intereses a {formatDate(claim.as_of)}</dt>
        <dd className="amt">{formatEUR(claim.interest_cents)}</dd>
        <small>de demora, Ley 3/2004</small>
      </div>
      <div>
        <dt>Compensación por costes de cobro</dt>
        <dd className="amt">{formatEUR(claim.compensation_cents)}</dd>
        <small>{COMPENSATION_LABELS[claim.compensation_mode]}</small>
      </div>
      <div>
        <dt>Total a reclamar</dt>
        <dd className="amt accent">{formatEUR(claim.total_cents)}</dd>
        <small>principal + intereses + compensación</small>
      </div>
    </dl>
  );
}

function Lines({ claim }: { claim: ClaimDetail }) {
  return (
    <section className="panel" aria-labelledby="facturas-titulo">
      <h2 id="facturas-titulo">Desglose por factura</h2>
      <p className="note">
        Estas cifras se calcularon al crear la reclamación y se guardaron tal
        cual: no cambian aunque después cambien las facturas.
      </p>
      <div className="table-wrapper">
        <table>
          <caption>
            Facturas de la reclamación<small>Importes en euros.</small>
          </caption>
          <thead>
            <tr>
              <th scope="col">Factura</th>
              <th scope="col" className="r">
                Principal
              </th>
              <th scope="col" className="r">
                Intereses
              </th>
            </tr>
          </thead>
          <tbody>
            {claim.lines.map((line) => (
              <tr key={line.invoice_id}>
                <th scope="row">{line.number}</th>
                <td data-label="Principal" className="r">
                  <span className="amt">{formatEUR(line.principal_cents)}</span>
                </td>
                <td data-label="Intereses" className="r">
                  <span className="amt">{formatEUR(line.interest_cents)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {claim.lines.map((line) => (
        <details key={line.invoice_id}>
          <summary>Tramos de interés de la factura {line.number}</summary>
          <div className="tablewrap">
            <table>
              <caption>
                Un tramo por cada periodo con el mismo saldo y el mismo tipo
              </caption>
              <thead>
                <tr>
                  <th scope="col">Desde</th>
                  <th scope="col">Hasta</th>
                  <th scope="col" className="r">
                    Días
                  </th>
                  <th scope="col" className="r">
                    Tipo
                  </th>
                  <th scope="col" className="r">
                    Saldo
                  </th>
                  <th scope="col" className="r">
                    Intereses
                  </th>
                </tr>
              </thead>
              <tbody>
                {line.segments.map((segment) => (
                  <tr key={segment.start}>
                    <td>{formatDate(segment.start)}</td>
                    <td>{formatDate(segment.end)}</td>
                    <td className="r amt">{String(segment.days)}</td>
                    <td className="r amt">{formatRate(segment.rate_bp)}</td>
                    <td className="r amt">
                      {formatEUR(segment.balance_cents)}
                    </td>
                    <td className="r amt">
                      {formatEUR(segment.interest_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={5}>
                    Total
                  </th>
                  <td className="r amt">{formatEUR(line.interest_cents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
      ))}
    </section>
  );
}

function LetterDownload({ claimId }: { claimId: string }) {
  const { busy, run } = useBusy();
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  // The button is disabled while the letter is prepared, which drops the keyboard focus: give it
  // back when the answer arrives.
  useEffect(() => {
    if (wasBusy.current && !busy) button.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  function download() {
    void run(async () => {
      setDone(false);
      setFailure(null);
      const result = await apiFile(
        `/api/claims/${encodeURIComponent(claimId)}/letter.pdf`,
        'application/pdf',
      );
      if (!result.ok) {
        setFailure(result);
        return;
      }
      saveFile(result.data.blob, result.data.filename ?? 'requerimiento.pdf');
      setDone(true);
    });
  }

  return (
    <>
      <div className="actions claim">
        <button
          ref={button}
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={download}
        >
          {busy ? 'Preparando…' : 'Descargar carta (PDF)'}
        </button>
        <p role="status" className="note">
          {busy
            ? 'Preparando la carta…'
            : done
              ? 'Carta descargada: la tienes en tu carpeta de descargas.'
              : ''}
        </p>
      </div>
      {failure ? (
        <div className="notice" role="alert">
          <p>{letterMessage(failure)}</p>
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

function CancelClaim({ claimId }: { claimId: string }) {
  const navigate = useNavigate();
  const { busy, run } = useBusy();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const firstRun = useRef(true);

  // Opening the confirmation puts the cursor on the safe choice; closing it gives focus back to
  // the button that opened it, so the keyboard never lands on a control that disappeared.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (confirming) keep.current?.focus();
    else opener.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (failure) alert.current?.focus();
  }, [failure]);

  function confirm() {
    void run(async () => {
      setFailure(null);
      const result = await api(
        'DELETE',
        `/api/claims/${encodeURIComponent(claimId)}`,
      );
      // A claim that is already gone is what the person wanted.
      if (!result.ok && result.kind !== 'not_found') {
        setFailure(result);
        return;
      }
      void navigate('/reclamaciones', {
        replace: true,
        state: { cancelled: true },
      });
    });
  }

  if (!confirming) {
    return (
      <div>
        <button
          ref={opener}
          type="button"
          className="btn danger-outline"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Cancelar reclamación
        </button>
      </div>
    );
  }
  return (
    <div className="notice" role="group" aria-labelledby="cancelar-titulo">
      <p id="cancelar-titulo">
        <b>¿Cancelar esta reclamación?</b>
      </p>
      <p>
        Se borra la reclamación y su historial, y sus facturas quedan libres
        para volver a reclamarlas. Si ya enviaste la carta o un correo al
        deudor, cancelar no lo deshace: él ya lo tiene.
      </p>
      {failure ? (
        <p ref={alert} role="alert" tabIndex={-1} className="field-error">
          {failureMessage(failure)}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={confirm}
        >
          {busy ? 'Cancelando…' : 'Sí, cancelar la reclamación'}
        </button>
        <button
          ref={keep}
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setFailure(null);
          }}
        >
          No, mantenerla
        </button>
      </div>
    </div>
  );
}

export function ClaimDetailPage() {
  const { id = '' } = useParams();
  const url = `/api/claims/${encodeURIComponent(id)}`;
  const load = useLoad<{ claim: ClaimDetail }>(url, () =>
    api<{ claim: ClaimDetail }>('GET', url),
  );

  if (load.result === null) {
    return (
      <ClaimFrame title="Reclamación · Reclama" back={BACK}>
        <ClaimLoading label="Cargando la reclamación…" />
      </ClaimFrame>
    );
  }
  if (!load.result.ok) {
    if (load.result.kind === 'not_found') {
      return (
        <ClaimFrame title="Reclamación no encontrada · Reclama" back={BACK}>
          <div className="card state">
            <h1>No encontramos esta reclamación</h1>
            <p>Puede que se haya cancelado o que el enlace no sea correcto.</p>
          </div>
        </ClaimFrame>
      );
    }
    return (
      <ClaimFrame title="Error al cargar la reclamación · Reclama" back={BACK}>
        <ClaimLoadError
          heading="No hemos podido cargar la reclamación"
          failure={load.result}
          retrying={load.reloading}
          onRetry={load.reload}
        />
      </ClaimFrame>
    );
  }
  const { claim } = load.result.data;

  return (
    <ClaimFrame
      title={`Reclamación a ${claim.debtor_name} · Reclama`}
      back={BACK}
    >
      <div className="head">
        <div>
          <h1>Reclamación a {claim.debtor_name}</h1>
          <p>Calculada a {formatDate(claim.as_of)}.</p>
        </div>
      </div>

      <Facts claim={claim} />
      <Lines claim={claim} />

      <section className="panel" aria-labelledby="carta-titulo">
        <h2 id="carta-titulo">Carta de requerimiento</h2>
        <p className="note">
          La carta sale con tus datos del perfil y con estas cifras. Revísala
          antes de enviarla: Reclama es una herramienta informativa, no
          asesoramiento jurídico.
        </p>
        <LetterDownload claimId={claim.id} />
      </section>

      <section className="panel" aria-labelledby="cancelar-seccion">
        <h2 id="cancelar-seccion">Cancelar la reclamación</h2>
        <CancelClaim claimId={claim.id} />
      </section>
    </ClaimFrame>
  );
}
