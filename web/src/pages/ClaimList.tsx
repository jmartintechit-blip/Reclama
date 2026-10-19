import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ClaimFrame, ClaimLoadError } from '../components/ClaimFrame.tsx';
import { StairMark } from '../components/StairMark.tsx';
import { api } from '../lib/api.ts';
import type { ClaimsPage, ClaimSummary } from '../lib/api-types.ts';
import {
  claimStatus,
  EVENT_LABELS,
  type ClaimStatusKind,
} from '../lib/claims.ts';
import { formatDate, formatEUR } from '../lib/format.ts';
import { useLoad } from '../lib/use-api.ts';

// The same pill as the invoices: a neutral one for a claim in progress, green when collected and
// red when blocked. The word is always there, the colour only helps.
const BADGE: Record<ClaimStatusKind, string> = {
  open: 'dispute',
  paid: 'paid',
  blocked: 'overdue',
};

function cancelledNotice(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    'cancelled' in state &&
    state.cancelled === true
  );
}

function ClaimTable({ claims }: { claims: ClaimSummary[] }) {
  return (
    <div className="card">
      <div className="table-wrapper">
        <table>
          <caption>
            Reclamaciones
            <small>
              Ordenadas por fecha de cálculo, las más recientes primero.
              Importes en euros.
            </small>
          </caption>
          <thead>
            <tr>
              <th scope="col">Deudor</th>
              <th scope="col">Calculada a</th>
              <th scope="col">Estado</th>
              <th scope="col" className="r">
                Facturas
              </th>
              <th scope="col" className="r">
                Total
              </th>
              <th scope="col">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {claims.map((claim) => {
              const status = claimStatus(claim);
              return (
                <tr key={claim.id}>
                  <th scope="row">{claim.debtor_name}</th>
                  <td data-label="Calculada a">
                    <span className="amt">{formatDate(claim.as_of)}</span>
                  </td>
                  <td data-label="Estado">
                    <span className={`badge ${BADGE[status.kind]}`}>
                      {status.text}
                    </span>
                    {claim.last_event ? (
                      <small>
                        {EVENT_LABELS[claim.last_event.kind]} el{' '}
                        {formatDate(claim.last_event.occurred_on)}
                      </small>
                    ) : null}
                  </td>
                  <td data-label="Facturas" className="r">
                    <span className="amt">{String(claim.invoice_count)}</span>
                  </td>
                  <td data-label="Total" className="r">
                    <span className="amt">{formatEUR(claim.total_cents)}</span>
                  </td>
                  <td>
                    <Link
                      className="btn small"
                      to={`/reclamaciones/${claim.id}`}
                      aria-label={`Ver la reclamación a ${claim.debtor_name}`}
                    >
                      Ver reclamación
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

export function ClaimList() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // Read once: the notice comes with the redirect after cancelling and must not come back when
  // the list is reloaded.
  const [cancelled] = useState(() => cancelledNotice(location.state));
  const offsetParam = Number(params.get('desde'));
  const offset =
    Number.isSafeInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  const path = `/api/claims${offset > 0 ? `?offset=${String(offset)}` : ''}`;
  const claims = useLoad<ClaimsPage>(path, () => api<ClaimsPage>('GET', path));

  function goTo(next: number) {
    const copy = new URLSearchParams(params);
    if (next <= 0) copy.delete('desde');
    else copy.set('desde', String(next));
    setParams(copy);
  }

  let body;
  if (claims.result === null) {
    body = (
      <div className="card state" role="status">
        <span className="sr-only">Cargando las reclamaciones…</span>
        <div className="skeleton" style={{ inlineSize: '70%' }} aria-hidden />
        <div className="skeleton" aria-hidden />
        <div className="skeleton" style={{ inlineSize: '85%' }} aria-hidden />
      </div>
    );
  } else if (!claims.result.ok) {
    body = (
      <ClaimLoadError
        heading="No hemos podido cargar las reclamaciones"
        level={2}
        failure={claims.result}
        retrying={claims.reloading}
        onRetry={claims.reload}
      />
    );
  } else {
    const { data } = claims.result;
    const { total, limit } = data.page;
    let list;
    if (total === 0) {
      list = (
        <div className="card state empty">
          <StairMark />
          <h2>Aún no has creado ninguna reclamación</h2>
          <p>
            Abre una factura vencida y pulsa «Crear reclamación»: Reclama
            calcula los intereses y te prepara la carta en PDF.
          </p>
          <div>
            <Link className="btn primary" to="/panel">
              Ver las facturas
            </Link>
          </div>
        </div>
      );
    } else if (data.claims.length === 0) {
      list = (
        <div className="card state">
          <h2>Esta página ya no existe</h2>
          <p>
            Hay {String(total)} reclamaciones, pero no tantas como para llegar
            aquí.
          </p>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                goTo(0);
              }}
            >
              Volver al principio
            </button>
          </div>
        </div>
      );
    } else {
      list = <ClaimTable claims={data.claims} />;
    }
    body = (
      <>
        {total > 0 && data.claims.length > 0 ? (
          <p className="note" role="status">
            Reclamaciones {String(offset + 1)} a{' '}
            {String(Math.min(offset + data.claims.length, total))} de{' '}
            {String(total)}.
          </p>
        ) : null}
        {list}
        {total > limit ? (
          <nav className="pager" aria-label="Páginas de reclamaciones">
            <button
              type="button"
              className="btn"
              disabled={offset === 0}
              onClick={() => {
                goTo(Math.max(0, offset - limit));
              }}
            >
              Anterior
            </button>
            <button
              type="button"
              className="btn"
              disabled={offset + limit >= total}
              onClick={() => {
                goTo(offset + limit);
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
    <ClaimFrame title="Reclamaciones · Reclama">
      <div className="head">
        <div>
          <h1>Reclamaciones</h1>
          <p>Las reclamaciones que has creado y su estado.</p>
        </div>
      </div>
      <div role="status" className="form-ok">
        {cancelled ? <p>Reclamación cancelada.</p> : null}
      </div>
      {body}
    </ClaimFrame>
  );
}
