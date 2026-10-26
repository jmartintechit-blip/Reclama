import { useId, useRef, useState, type SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ClaimFrame,
  ClaimLoadError,
  ClaimLoading,
} from '../components/ClaimFrame.tsx';
import {
  COMPENSATION_OPTIONS,
  CompensationOption,
} from '../components/CompensationChoices.tsx';
import { ErrorSummary, TextField } from '../components/Field.tsx';
import { asOfProblem, MIN_AS_OF } from '../components/InterestSection.tsx';
import { api, type ApiResult, type Failure } from '../lib/api.ts';
import type {
  ClaimDetail,
  Debtor,
  InvoicesPage,
  InvoiceView,
} from '../lib/api-types.ts';
import { debtorBlocker, MAX_INVOICES_PER_CLAIM } from '../lib/claims.ts';
import { todayMadrid } from '../lib/dates.ts';
import { formatDate, formatEUR } from '../lib/format.ts';
import {
  errorsFromFailure,
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import { dueNote } from '../lib/invoice-list.ts';
import { createClaimMessage } from '../lib/messages.ts';
import { useSession, type Compensation } from '../lib/session.tsx';
import { useLoad } from '../lib/use-api.ts';

const BACK = { to: '/panel', label: 'Ver todas las facturas' };
const PAGE = 100;

const LABELS = {
  invoice_ids: 'Facturas',
  as_of: 'Fecha de cálculo',
  compensation_mode: 'Compensación de 40 €',
  accept: 'Aviso legal',
};
const FIELDS = ['invoice_ids', 'as_of', 'compensation_mode'] as const;

// The open invoices of one debtor, every page of them: the claim can hold up to
// MAX_INVOICES_PER_CLAIM, but the person must see them all to choose.
async function loadOpenInvoices(
  debtorId: string,
): Promise<ApiResult<InvoiceView[]>> {
  const found: InvoiceView[] = [];
  let offset = 0;
  for (;;) {
    const result = await api<InvoicesPage>(
      'GET',
      `/api/invoices?debtor_id=${encodeURIComponent(debtorId)}&status=OPEN&limit=${String(PAGE)}&offset=${String(offset)}`,
    );
    if (!result.ok) return result;
    found.push(...result.data.invoices);
    offset += result.data.page.limit;
    if (result.data.invoices.length === 0 || offset >= result.data.page.total) {
      return { ok: true, data: found };
    }
  }
}

// A server refusal -> what to show. Business errors get their own text; a validation error with
// field details is pinned to its fields.
function claimErrors(failure: Failure): FormErrors {
  const message = createClaimMessage(failure);
  if (message === null) return errorsFromFailure(failure, FIELDS);
  if (failure.code === 'AS_OF_IN_FUTURE') {
    return withFieldErrors({ as_of: message });
  }
  return { summary: message, fields: {} };
}

function ClaimForm({
  debtor,
  candidates,
  today,
}: {
  debtor: Debtor;
  candidates: InvoiceView[];
  today: string;
}) {
  const navigate = useNavigate();
  const { profile } = useSession();
  const { busy, run } = useBusy();
  // null means "the default": every candidate, without keeping a copy that could go stale.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [asOf, setAsOf] = useState('');
  const [mode, setMode] = useState<Compensation>(
    profile?.default_compensation ?? 'PER_CLAIM',
  );
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const form = useRef<HTMLFormElement>(null);
  const invoicesError = useId();
  const acceptError = useId();
  // The error belongs to the unticked box: ticking it answers it.
  const showAcceptError = !accepted && Boolean(errors.fields.accept);
  useFocusOnErrors(errors, form);

  const chosen = selected ?? new Set(candidates.map((invoice) => invoice.id));

  function toggle(id: string) {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const fields: Record<string, string> = {};
      if (chosen.size === 0) {
        fields.invoice_ids = 'Elige al menos una factura.';
      } else if (chosen.size > MAX_INVOICES_PER_CLAIM) {
        fields.invoice_ids = `Una reclamación admite como máximo ${String(MAX_INVOICES_PER_CLAIM)} facturas: desmarca algunas y reclama el resto en una segunda reclamación.`;
      }
      const problem = asOfProblem(asOf, today);
      if (problem !== null) fields.as_of = problem;
      if (!accepted) fields.accept = 'Marca la casilla para continuar.';
      if (Object.keys(fields).length > 0) {
        setErrors(withFieldErrors(fields));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api<{ claim: ClaimDetail }>('POST', '/api/claims', {
        debtor_id: debtor.id,
        // With every invoice chosen the server picks them itself, and leaves out the ones that
        // are already in another claim instead of refusing the whole request.
        ...(chosen.size === candidates.length
          ? {}
          : { invoice_ids: [...chosen] }),
        ...(asOf === '' ? {} : { as_of: asOf }),
        compensation_mode: mode,
      });
      if (!result.ok) {
        setErrors(claimErrors(result));
        return;
      }
      void navigate(`/reclamaciones/${result.data.claim.id}`);
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

      <section className="panel" aria-labelledby="facturas-titulo">
        <h2 id="facturas-titulo">Facturas que se reclaman</h2>
        <p className="note">
          Solo salen las facturas vencidas y sin cobrar del todo. Una factura
          que ya está en otra reclamación no se reclama dos veces: con todas
          marcadas se deja fuera sola; con una selección a mano, te avisamos.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setSelected(new Set(candidates.map((invoice) => invoice.id)));
            }}
          >
            Marcar todas
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            Desmarcar todas
          </button>
        </div>
        <p className="note" role="status">
          {String(chosen.size)} de {String(candidates.length)} facturas
          seleccionadas.
        </p>
        <div className="table-wrapper">
          <table
            aria-describedby={
              errors.fields.invoice_ids ? invoicesError : undefined
            }
          >
            <caption>
              Facturas vencidas de {debtor.name}
              <small>Importes en euros.</small>
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Incluir</span>
                </th>
                <th scope="col">Factura</th>
                <th scope="col">Vencimiento</th>
                <th scope="col" className="r">
                  Pendiente
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((invoice) => {
                const note = dueNote(invoice, today);
                return (
                  <tr key={invoice.id}>
                    <td>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={chosen.has(invoice.id)}
                          onChange={() => {
                            toggle(invoice.id);
                          }}
                        />
                        <span className="sr-only">
                          Incluir la factura {invoice.number}
                        </span>
                      </label>
                    </td>
                    <th scope="row">{invoice.number}</th>
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
                    <td data-label="Pendiente" className="r">
                      <span className="amt">
                        {formatEUR(invoice.balance_cents)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {errors.fields.invoice_ids ? (
          <p id={invoicesError} className="field-error">
            {errors.fields.invoice_ids}
          </p>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="fecha-titulo">
        <h2 id="fecha-titulo">Fecha de cálculo</h2>
        <div className="asof">
          <TextField
            label="Calcular los intereses hasta"
            name="as_of"
            type="date"
            min={MIN_AS_OF}
            max={today}
            value={asOf}
            onChange={(event) => {
              setAsOf(event.target.value);
            }}
            error={errors.fields.as_of}
            hint="Por defecto, hoy."
          />
        </div>
      </section>

      <section className="panel" aria-labelledby="compensacion-titulo">
        <fieldset className="field">
          <legend id="compensacion-titulo">
            Compensación por costes de cobro
          </legend>
          <p className="hint">
            La ley de morosidad permite reclamar 40 € por los costes de cobro,
            pero no deja claro si son 40 € por cada factura o 40 € por toda la
            reclamación, y la jurisprudencia no es uniforme. Si dudas, deja la
            opción más prudente: 40 € por reclamación.
          </p>
          <div className="choices">
            {COMPENSATION_OPTIONS.map((option) => (
              <CompensationOption
                key={option.value}
                name="compensation_mode"
                option={option}
                checked={mode === option.value}
                onSelect={() => {
                  setMode(option.value);
                }}
              />
            ))}
          </div>
          {errors.fields.compensation_mode ? (
            <p className="field-error">{errors.fields.compensation_mode}</p>
          ) : null}
        </fieldset>
      </section>

      <section className="panel" aria-labelledby="crear-titulo">
        <h2 id="crear-titulo">Crear la reclamación</h2>
        <p className="note">
          Los intereses y los totales los calcula el servidor al crear la
          reclamación y se guardan tal cual: los verás en la pantalla siguiente,
          junto a la carta en PDF.
        </p>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={accepted}
              aria-invalid={showAcceptError ? true : undefined}
              aria-describedby={showAcceptError ? acceptError : undefined}
              onChange={(event) => {
                setAccepted(event.target.checked);
              }}
            />
            Entiendo que Reclama es una herramienta informativa de ayuda al
            cobro, no asesoramiento jurídico.
          </label>
          {showAcceptError ? (
            <p id={acceptError} className="field-error">
              {errors.fields.accept}
            </p>
          ) : null}
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Creando…' : 'Crear reclamación'}
          </button>
        </div>
      </section>
    </form>
  );
}

export function NewClaim() {
  const [params] = useSearchParams();
  const debtorId = params.get('deudor')?.trim() ?? '';
  const [today] = useState(() => todayMadrid());

  const debtorUrl =
    debtorId === '' ? null : `/api/debtors/${encodeURIComponent(debtorId)}`;
  const debtor = useLoad<{ debtor: Debtor }>(debtorUrl, () =>
    api<{ debtor: Debtor }>('GET', debtorUrl ?? ''),
  );
  const invoices = useLoad<InvoiceView[]>(
    debtorId === '' ? null : `open-invoices:${debtorId}`,
    () => loadOpenInvoices(debtorId),
  );

  if (debtorId === '') {
    return (
      <ClaimFrame title="Nueva reclamación · Reclama" back={BACK}>
        <div className="card state">
          <h1>Falta elegir el deudor</h1>
          <p>
            Una reclamación se crea desde una factura vencida: ábrela y pulsa
            «Crear reclamación».
          </p>
          <div>
            <Link className="btn primary" to="/panel">
              Ir a las facturas
            </Link>
          </div>
        </div>
      </ClaimFrame>
    );
  }

  const retry = () => {
    debtor.reload();
    invoices.reload();
  };
  if (debtor.result === null || invoices.result === null) {
    return (
      <ClaimFrame title="Nueva reclamación · Reclama" back={BACK}>
        <ClaimLoading label="Cargando las facturas del deudor…" />
      </ClaimFrame>
    );
  }
  if (!debtor.result.ok && debtor.result.kind === 'not_found') {
    return (
      <ClaimFrame title="Deudor no encontrado · Reclama" back={BACK}>
        <div className="card state">
          <h1>No encontramos este deudor</h1>
          <p>Puede que se haya borrado o que el enlace no sea correcto.</p>
        </div>
      </ClaimFrame>
    );
  }
  const failure = !debtor.result.ok
    ? debtor.result
    : !invoices.result.ok
      ? invoices.result
      : null;
  if (failure !== null) {
    return (
      <ClaimFrame title="Error al cargar · Reclama" back={BACK}>
        <ClaimLoadError
          heading="No hemos podido cargar los datos de la reclamación"
          failure={failure}
          retrying={debtor.reloading || invoices.reloading}
          onRetry={retry}
        />
      </ClaimFrame>
    );
  }
  if (!debtor.result.ok || !invoices.result.ok) return null;

  const debtorData = debtor.result.data.debtor;
  const candidates = invoices.result.data.filter(
    (invoice) =>
      invoice.status === 'OPEN' && invoice.overdue && invoice.balance_cents > 0,
  );
  const blocker = debtorBlocker(debtorData.kind);

  let body;
  if (blocker !== null) {
    const first = invoices.result.data[0];
    body = (
      <div className="notice" role="alert">
        <p>{blocker}</p>
        {debtorData.kind === 'UNKNOWN' && first ? (
          <Link className="btn" to={`/facturas/${first.id}`}>
            Abrir una factura de este deudor para clasificarlo
          </Link>
        ) : null}
      </div>
    );
  } else if (candidates.length === 0) {
    body = (
      <div className="card state">
        <h2>No hay facturas que reclamar</h2>
        <p>
          Este deudor no tiene facturas vencidas y sin cobrar del todo. Cuando
          una venza, podrás reclamarla desde aquí.
        </p>
      </div>
    );
  } else {
    body = (
      <ClaimForm debtor={debtorData} candidates={candidates} today={today} />
    );
  }

  return (
    <ClaimFrame title="Nueva reclamación · Reclama" back={BACK}>
      <div className="head">
        <div>
          <h1>Nueva reclamación</h1>
          <p>Deudor: {debtorData.name}</p>
        </div>
      </div>
      {body}
    </ClaimFrame>
  );
}
