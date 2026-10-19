import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { DebtorSection } from '../components/DebtorSection.tsx';
import {
  asOfProblem,
  InterestSection,
} from '../components/InterestSection.tsx';
import { PaymentsSection } from '../components/PaymentsSection.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import type {
  Debtor,
  Interest,
  InvoiceDetail as InvoiceDetailData,
} from '../lib/api-types.ts';
import { api, type Failure } from '../lib/api.ts';
import { todayMadrid } from '../lib/dates.ts';
import { formatDate, formatDays, formatEUR } from '../lib/format.ts';
import { failureMessage } from '../lib/messages.ts';
import { useLoad } from '../lib/use-api.ts';

const BackLink = () => (
  <Link className="back" to="/panel">
    <span aria-hidden="true">←</span> Ver todas las facturas
  </Link>
);

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wrap panel-page">
      <title>{title}</title>
      <BackLink />
      {children}
    </div>
  );
}

// Why "Crear reclamación" cannot be pressed yet, or null when it can.
function claimBlocker(
  invoice: InvoiceDetailData,
  debtor: Debtor | null,
): string | null {
  if (invoice.status === 'PAID') {
    return 'La factura está cobrada por completo: no hay nada que reclamar.';
  }
  if (!invoice.overdue) return 'La factura todavía no ha vencido.';
  if (debtor === null) return 'Cargando los datos del deudor…';
  switch (debtor.kind) {
    case 'BUSINESS':
      return null;
    case 'UNKNOWN':
      return 'Marca al deudor como empresa o autónomo para poder reclamar.';
    case 'CONSUMER':
      return 'Reclama no reclama a consumidores: quedan fuera de la ley de morosidad.';
    case 'PUBLIC_ADMIN':
      return 'Reclama no tramita reclamaciones a administraciones públicas.';
  }
}

function Facts({
  invoice,
  interest,
}: {
  invoice: InvoiceDetailData;
  interest: Interest | null;
}) {
  const due = invoice.due_date_effective;
  const days = interest?.segments.reduce((sum, s) => sum + s.days, 0) ?? 0;
  return (
    <dl className="facts">
      <div>
        <dt>Importe</dt>
        <dd className="amt">{formatEUR(invoice.amount_cents)}</dd>
        <small>emitida el {formatDate(invoice.issue_date)}</small>
      </div>
      <div>
        <dt>Cobrado</dt>
        <dd className="amt">{formatEUR(invoice.paid_cents)}</dd>
        <small>
          {invoice.payments.length === 0
            ? 'ningún cobro'
            : `${String(invoice.payments.length)} ${invoice.payments.length === 1 ? 'cobro' : 'cobros'}`}
        </small>
      </div>
      <div>
        <dt>Pendiente</dt>
        <dd className="amt">{formatEUR(invoice.balance_cents)}</dd>
        <small>
          {due === null
            ? 'sin fecha de vencimiento'
            : `${invoice.overdue ? 'venció' : 'vence'} el ${formatDate(due)}${invoice.due_date_estimated ? ' (estimado)' : ''}`}
        </small>
      </div>
      <div>
        <dt>Intereses{interest ? ` a ${formatDate(interest.as_of)}` : ''}</dt>
        <dd className="amt accent">
          {interest ? formatEUR(interest.interest_cents) : 'No disponible'}
        </dd>
        <small>
          {interest
            ? interest.segments.length === 0
              ? 'sin días de retraso'
              : `${formatDays(days)} en ${String(interest.segments.length)} ${interest.segments.length === 1 ? 'tramo' : 'tramos'}`
            : 'consulta el desglose'}
        </small>
      </div>
    </dl>
  );
}

function Loading() {
  return (
    <Frame title="Factura · Reclama">
      <div className="card state" role="status">
        <span className="sr-only">Cargando la factura…</span>
        <div className="skeleton" style={{ inlineSize: '40%' }} aria-hidden />
        <div className="skeleton" aria-hidden />
        <div className="skeleton" style={{ inlineSize: '85%' }} aria-hidden />
      </div>
    </Frame>
  );
}

function LoadFailed({
  failure,
  retrying,
  onRetry,
}: {
  failure: Failure;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (failure.kind === 'not_found') {
    return (
      <Frame title="Factura no encontrada · Reclama">
        <div className="card state">
          <h1>No encontramos esta factura</h1>
          <p>Puede que se haya borrado o que el enlace no sea correcto.</p>
        </div>
      </Frame>
    );
  }
  return (
    <Frame title="Error al cargar la factura · Reclama">
      <div className="card state error" role="alert">
        <h1>No hemos podido cargar la factura</h1>
        <p>{failureMessage(failure)}</p>
        <div>
          <button
            type="button"
            className="btn"
            disabled={retrying}
            onClick={onRetry}
          >
            Reintentar
          </button>
        </div>
      </div>
    </Frame>
  );
}

export function InvoiceDetail() {
  const { id = '' } = useParams();
  const [today] = useState(() => todayMadrid());
  const [asOf, setAsOf] = useState('');

  const invoiceUrl = `/api/invoices/${encodeURIComponent(id)}`;
  const invoice = useLoad<{ invoice: InvoiceDetailData }>(invoiceUrl, () =>
    api<{ invoice: InvoiceDetailData }>('GET', invoiceUrl),
  );

  // A date that is not usable (in the future) is not sent: the calculation stays on today.
  const useAsOf =
    asOf !== '' && asOf !== today && asOfProblem(asOf, today) === null;
  const interestUrl = `${invoiceUrl}/interest${useAsOf ? `?as_of=${asOf}` : ''}`;
  const interest = useLoad<{ interest: Interest }>(interestUrl, () =>
    api<{ interest: Interest }>('GET', interestUrl),
  );

  const debtorId =
    invoice.result?.ok === true ? invoice.result.data.invoice.debtor_id : null;
  const debtorUrl =
    debtorId === null ? null : `/api/debtors/${encodeURIComponent(debtorId)}`;
  const debtorLoad = useLoad<{ debtor: Debtor }>(debtorUrl, () =>
    api<{ debtor: Debtor }>('GET', debtorUrl ?? ''),
  );

  if (invoice.result === null) return <Loading />;
  if (!invoice.result.ok) {
    return (
      <LoadFailed
        failure={invoice.result}
        retrying={invoice.reloading}
        onRetry={invoice.reload}
      />
    );
  }
  const invoiceData = invoice.result.data.invoice;

  const debtor =
    debtorLoad.result?.ok === true ? debtorLoad.result.data.debtor : null;
  const interestResult =
    interest.result === null
      ? null
      : interest.result.ok
        ? ({ ok: true, data: interest.result.data.interest } as const)
        : interest.result;
  const blocker = claimBlocker(invoiceData, debtor);

  // After a payment the invoice (balance, status, payments) and the interest are asked again
  // and the Timeline redraws; the list refreshes itself when it is opened.
  const recorded = () => {
    invoice.reload();
    interest.reload();
  };

  return (
    <Frame title={`Factura ${invoiceData.number} · Reclama`}>
      <div className="head">
        <div>
          <h1>Factura {invoiceData.number}</h1>
          <p>{debtor?.name ?? ' '}</p>
        </div>
        <StatusBadge invoice={invoiceData} />
      </div>

      <Facts
        invoice={invoiceData}
        interest={interestResult?.ok ? interestResult.data : null}
      />

      <InterestSection
        invoice={invoiceData}
        result={interestResult}
        retrying={interest.reloading}
        onRetry={interest.reload}
        today={today}
        asOf={asOf}
        onAsOfChange={setAsOf}
      />

      <PaymentsSection
        invoice={invoiceData}
        today={today}
        onRecorded={recorded}
      />

      {debtorLoad.result === null ? (
        <section className="panel" aria-labelledby="deudor-titulo">
          <h2 id="deudor-titulo">Deudor</h2>
          <div className="state" role="status">
            <span className="sr-only">Cargando el deudor…</span>
            <div className="skeleton" aria-hidden />
          </div>
        </section>
      ) : debtorLoad.result.ok ? (
        <DebtorSection
          debtor={debtorLoad.result.data.debtor}
          onSaved={debtorLoad.reload}
        />
      ) : (
        <section className="panel" aria-labelledby="deudor-titulo">
          <h2 id="deudor-titulo">Deudor</h2>
          <div className="notice" role="alert">
            <p>{failureMessage(debtorLoad.result)}</p>
            <button
              type="button"
              className="btn"
              disabled={debtorLoad.reloading}
              onClick={debtorLoad.reload}
            >
              Reintentar
            </button>
          </div>
        </section>
      )}

      <div className="actions claim">
        {blocker === null ? (
          <Link
            className="btn primary"
            to={`/reclamaciones/nueva?deudor=${encodeURIComponent(invoiceData.debtor_id)}`}
          >
            Crear reclamación
          </Link>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled
              aria-describedby="claim-reason"
            >
              Crear reclamación
            </button>
            <p id="claim-reason" className="note">
              {blocker}
            </p>
          </>
        )}
      </div>
    </Frame>
  );
}
