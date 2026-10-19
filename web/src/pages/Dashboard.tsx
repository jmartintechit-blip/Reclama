import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { StairMark } from '../components/StairMark.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { api, type ApiResult, type Failure } from '../lib/api.ts';
import type {
  Debtor,
  DebtorsPage,
  InvoicesPage,
  InvoiceTotals,
  InvoiceView,
} from '../lib/api-types.ts';
import { todayMadrid } from '../lib/dates.ts';
import { formatDate, formatEUR } from '../lib/format.ts';
import {
  dueNote,
  FILTERS,
  filterFromParam,
  type FilterId,
} from '../lib/invoice-list.ts';
import { failureMessage } from '../lib/messages.ts';
import { useLoad } from '../lib/use-api.ts';

const DEBTOR_PAGE = 100;
// Mirrors the API: the totals are computed over at most this many invoices.
const TOTALS_CAP = 2000;

// The list carries the debtor's id, not its name, so the names come from the debtors endpoint
// (a few pages at most) and are matched here.
async function loadDebtors(): Promise<ApiResult<Map<string, Debtor>>> {
  const names = new Map<string, Debtor>();
  let offset = 0;
  for (;;) {
    const result = await api<DebtorsPage>(
      'GET',
      `/api/debtors?limit=${String(DEBTOR_PAGE)}&offset=${String(offset)}`,
    );
    if (!result.ok) return result;
    for (const debtor of result.data.debtors) names.set(debtor.id, debtor);
    offset += result.data.page.limit;
    if (result.data.debtors.length === 0 || offset >= result.data.page.total) {
      return { ok: true, data: names };
    }
  }
}

function Skeleton() {
  return (
    <div className="card state" role="status">
      <span className="sr-only">Cargando facturas…</span>
      <div className="skeleton" style={{ inlineSize: '70%' }} aria-hidden />
      <div className="skeleton" aria-hidden />
      <div className="skeleton" style={{ inlineSize: '85%' }} aria-hidden />
      <div className="skeleton" aria-hidden />
    </div>
  );
}

function ErrorState({
  failure,
  retrying,
  onRetry,
}: {
  failure: Failure;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="card state error" role="alert">
      <h2>No hemos podido cargar las facturas</h2>
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
  );
}

function EmptyState() {
  return (
    <div className="card state empty">
      <StairMark />
      <h2>Aún no tienes facturas</h2>
      <p>
        Importa el CSV que exporta tu programa de facturación y aquí verás
        cuánto te deben y los intereses de cada factura.
      </p>
      <div>
        <Link className="btn primary" to="/importar">
          Importar CSV
        </Link>
      </div>
      <p className="hint">
        ¿Solo quieres mirar? La demo de la portada trae facturas ficticias ya
        cargadas.
      </p>
    </div>
  );
}

function Summary({ totals }: { totals: InvoiceTotals }) {
  const unavailable = totals.interest_unavailable_count;
  return (
    <section className="kpis" aria-label="Resumen">
      <div className="kpi">
        <h2>Pendiente de cobro</h2>
        <p className="value amt">{formatEUR(totals.outstanding_cents)}</p>
        <p className="note">
          Lo que falta por cobrar en las facturas no pagadas
        </p>
      </div>
      <div className="kpi">
        <h2>Intereses de demora</h2>
        <p className="value amt">{formatEUR(totals.interest_cents)}</p>
        <p className="note">
          Solo suma las facturas cuyos intereses se han podido calcular.
          {unavailable > 0
            ? ` En ${String(unavailable)} ${unavailable === 1 ? 'factura' : 'facturas'} no se han podido calcular y no están en esta suma.`
            : ''}
        </p>
      </div>
      <div className={`kpi${totals.overdue_count > 0 ? ' alert' : ''}`}>
        <h2>Facturas vencidas</h2>
        <p className="value amt">{String(totals.overdue_count)}</p>
        <p className="note">
          Sin pagar del todo y pasada su fecha de vencimiento
        </p>
      </div>
      {totals.truncated ? (
        <p className="note kpis-note">
          Los totales solo incluyen las primeras {String(TOTALS_CAP)} facturas.
        </p>
      ) : null}
    </section>
  );
}

function InvoiceTable({
  invoices,
  debtors,
  today,
}: {
  invoices: InvoiceView[];
  debtors: Map<string, Debtor>;
  today: string;
}) {
  return (
    <div className="card">
      <div className="table-wrapper">
        <table>
          <caption>
            Facturas
            <small>
              Ordenadas por fecha de emisión, las más recientes primero.
              Importes en euros.
            </small>
          </caption>
          <thead>
            <tr>
              <th scope="col">Factura</th>
              <th scope="col">Deudor</th>
              <th scope="col">Vencimiento</th>
              <th scope="col">Estado</th>
              <th scope="col" className="r">
                Pendiente
              </th>
              <th scope="col" className="r">
                Intereses
              </th>
              <th scope="col">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const note = dueNote(invoice, today);
              return (
                <tr key={invoice.id}>
                  <th scope="row">{invoice.number}</th>
                  <td data-label="Deudor">
                    {debtors.get(invoice.debtor_id)?.name ??
                      'Deudor sin nombre'}
                  </td>
                  <td data-label="Vencimiento">
                    <span className="amt">
                      {invoice.due_date_effective
                        ? formatDate(invoice.due_date_effective)
                        : 'Sin fecha'}
                    </span>
                    {invoice.due_date_estimated ? (
                      <small>vencimiento estimado</small>
                    ) : null}
                    {note ? <small>{note}</small> : null}
                  </td>
                  <td data-label="Estado">
                    <StatusBadge invoice={invoice} />
                  </td>
                  <td data-label="Pendiente" className="r">
                    <span className="amt">
                      {formatEUR(invoice.balance_cents)}
                    </span>
                  </td>
                  <td data-label="Intereses" className="r">
                    {invoice.interest_cents === null ? (
                      <span>No calculables</span>
                    ) : (
                      <span className="amt">
                        {formatEUR(invoice.interest_cents)}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link
                      className="btn small"
                      to={`/facturas/${invoice.id}`}
                      aria-label={`Ver desglose de la factura ${invoice.number}`}
                    >
                      Ver desglose
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParam(params.get('filtro'));
  const offsetParam = Number(params.get('desde'));
  const offset =
    Number.isSafeInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;
  const [today] = useState(() => todayMadrid());

  const path = `/api/invoices${offset > 0 ? `?offset=${String(offset)}` : ''}`;
  const invoices = useLoad<InvoicesPage>(path, () =>
    api<InvoicesPage>('GET', path),
  );
  const debtors = useLoad('debtors', loadDebtors);

  function update(next: { filtro?: FilterId; desde?: number }) {
    const copy = new URLSearchParams(params);
    const f = next.filtro ?? filter;
    const d = next.desde ?? offset;
    if (f === 'todas') copy.delete('filtro');
    else copy.set('filtro', f);
    if (d <= 0) copy.delete('desde');
    else copy.set('desde', String(d));
    setParams(copy);
  }

  const retry = () => {
    invoices.reload();
    debtors.reload();
  };
  const retrying = invoices.reloading || debtors.reloading;

  let body;
  if (invoices.result === null || debtors.result === null) {
    body = <Skeleton />;
  } else if (!invoices.result.ok) {
    body = (
      <ErrorState
        failure={invoices.result}
        retrying={retrying}
        onRetry={retry}
      />
    );
  } else if (!debtors.result.ok) {
    body = (
      <ErrorState
        failure={debtors.result}
        retrying={retrying}
        onRetry={retry}
      />
    );
  } else {
    const { data } = invoices.result;
    const names = debtors.result.data;
    const { total, limit } = data.page;
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    const rows = data.invoices.filter(test);
    const last = Math.min(offset + data.invoices.length, total);
    const moreThanAPage = total > limit;

    let list;
    if (total === 0) {
      list = <EmptyState />;
    } else if (data.invoices.length === 0) {
      list = (
        <div className="card state">
          <h2>Esta página ya no existe</h2>
          <p>
            Hay {String(total)} facturas, pero no tantas como para llegar aquí.
          </p>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                update({ desde: 0 });
              }}
            >
              Volver al principio
            </button>
          </div>
        </div>
      );
    } else if (rows.length === 0) {
      list = (
        <div className="card state">
          <h2>Ninguna factura coincide con el filtro</h2>
          <p>
            {moreThanAPage
              ? 'Solo hemos mirado las facturas de esta página; puede haber coincidencias en las otras.'
              : 'Prueba con otro filtro o quítalo para ver todas.'}
          </p>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                update({ filtro: 'todas' });
              }}
            >
              Quitar filtro
            </button>
          </div>
        </div>
      );
    } else {
      list = <InvoiceTable invoices={rows} debtors={names} today={today} />;
    }

    body = (
      <>
        {total > 0 ? <Summary totals={data.totals} /> : null}
        {total > 0 ? (
          <>
            <div className="filters" role="group" aria-label="Filtrar facturas">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="chip"
                  aria-pressed={f.id === filter}
                  onClick={() => {
                    update({ filtro: f.id });
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="note" role="status">
              {filter === 'todas'
                ? `Facturas ${String(offset + 1)} a ${String(last)} de ${String(total)}.`
                : `${String(rows.length)} de las ${String(data.invoices.length)} facturas de esta página${moreThanAPage ? '; el filtro no mira las demás páginas' : ''}.`}
            </p>
          </>
        ) : null}
        {list}
        {moreThanAPage ? (
          <nav className="pager" aria-label="Páginas de facturas">
            <button
              type="button"
              className="btn"
              disabled={offset === 0}
              onClick={() => {
                update({ desde: Math.max(0, offset - limit) });
              }}
            >
              Anterior
            </button>
            <button
              type="button"
              className="btn"
              disabled={offset + limit >= total}
              onClick={() => {
                update({ desde: offset + limit });
              }}
            >
              Siguiente
            </button>
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <div className="wrap panel-page">
      <title>Facturas · Reclama</title>
      <div className="head">
        <div>
          <h1>Facturas</h1>
          <p>
            Intereses calculados a {formatDate(today)} con los tipos de demora
            del BOE.
          </p>
        </div>
      </div>
      {body}
    </div>
  );
}
