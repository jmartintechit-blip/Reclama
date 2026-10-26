import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type Failure } from '../lib/api.ts';
import type { InvoiceDetail } from '../lib/api-types.ts';
import { useBusy } from '../lib/forms.ts';
import { failureMessage } from '../lib/messages.ts';

// What the server answers when the invoice cannot change, in words; anything else falls back to
// the generic text of the failure.
function actionMessage(failure: Failure): string {
  if (failure.code === 'INVOICE_IN_CLAIM') {
    return 'Esta factura está en una reclamación y ya no admite cambios. Cancela la reclamación primero.';
  }
  return failureMessage(failure);
}

function DeleteInvoice({ invoice }: { invoice: InvoiceDetail }) {
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
        `/api/invoices/${encodeURIComponent(invoice.id)}`,
      );
      // An invoice that is already gone is what the person wanted.
      if (!result.ok && result.kind !== 'not_found') {
        setFailure(result);
        return;
      }
      void navigate('/panel', { replace: true });
    });
  }

  if (!confirming) {
    return (
      <button
        ref={opener}
        type="button"
        className="btn danger-outline"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Borrar factura
      </button>
    );
  }
  return (
    <div className="notice" role="group" aria-labelledby="borrar-titulo">
      <p id="borrar-titulo">
        <b>¿Borrar la factura {invoice.number}?</b>
      </p>
      <p>Se borran también sus cobros. No se puede deshacer.</p>
      {failure ? (
        <p ref={alert} role="alert" tabIndex={-1} className="field-error">
          {actionMessage(failure)}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={confirm}
        >
          {busy ? 'Borrando…' : 'Sí, borrar la factura'}
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
          No, conservarla
        </button>
      </div>
    </div>
  );
}

// Edit, dispute/reopen and delete. A paid invoice has no dispute toggle: it follows its payments.
export function InvoiceActions({
  invoice,
  onChanged,
}: {
  invoice: InvoiceDetail;
  onChanged: () => void;
}) {
  const { busy, run } = useBusy();
  const [failure, setFailure] = useState<Failure | null>(null);
  const disputed = invoice.status === 'DISPUTED';

  function toggleDispute() {
    void run(async () => {
      setFailure(null);
      const result = await api(
        'PATCH',
        `/api/invoices/${encodeURIComponent(invoice.id)}`,
        { status: disputed ? 'OPEN' : 'DISPUTED' },
      );
      if (!result.ok) {
        setFailure(result);
        return;
      }
      onChanged();
    });
  }

  return (
    <section className="panel" aria-labelledby="gestion-titulo">
      <h2 id="gestion-titulo">Gestionar la factura</h2>
      <div className="actions">
        <Link
          className="btn"
          to={`/facturas/${encodeURIComponent(invoice.id)}/editar`}
        >
          Editar factura
        </Link>
        {invoice.status === 'PAID' ? null : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={toggleDispute}
          >
            {disputed ? 'Quitar la disputa' : 'Marcar como disputada'}
          </button>
        )}
        <DeleteInvoice invoice={invoice} />
      </div>
      {failure ? (
        <p role="alert" className="field-error">
          {actionMessage(failure)}
        </p>
      ) : null}
    </section>
  );
}
