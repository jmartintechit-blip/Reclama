import { useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ErrorSummary, SelectField, TextField } from '../components/Field.tsx';
import type { Debtor, InvoiceDetail } from '../lib/api-types.ts';
import { api, type Failure } from '../lib/api.ts';
import { loadDebtors } from '../lib/debtors.ts';
import { formatEUR } from '../lib/format.ts';
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
import { EMAIL_INVALID_MESSAGE, failureMessage } from '../lib/messages.ts';
import { centsToInput, moneyErrorMessage, parseMoney } from '../lib/money.ts';
import { useLoad } from '../lib/use-api.ts';

const NEW_DEBTOR = 'new';
const LABELS: Record<string, string> = {
  debtor_id: 'Deudor',
  'debtor.name': 'Nombre del deudor',
  'debtor.tax_id': 'NIF del deudor',
  'debtor.email': 'Email del deudor',
  number: 'Número de factura',
  issue_date: 'Fecha de emisión',
  due_date: 'Fecha de vencimiento',
  amount_cents: 'Importe',
};
const FIELDS = Object.keys(LABELS);

// The server's business errors, in Spanish and next to the field they are about.
function invoiceErrors(failure: Failure): FormErrors {
  const extra = failure.extra ?? {};
  switch (failure.code) {
    case 'INVOICE_DUPLICATE':
      return withFieldErrors({
        number: 'Este deudor ya tiene una factura con este número.',
      });
    case 'DUE_BEFORE_ISSUE':
      return withFieldErrors({
        due_date: 'El vencimiento no puede ser anterior a la emisión.',
      });
    case 'AMOUNT_BELOW_PAID': {
      const paid = extra.paid_cents;
      return withFieldErrors({
        amount_cents:
          typeof paid === 'number' && Number.isSafeInteger(paid)
            ? `No puede ser menos de lo ya cobrado (${formatEUR(paid)}).`
            : 'No puede ser menos de lo ya cobrado.',
      });
    }
    case 'PAYMENT_BEFORE_ISSUE':
      return withFieldErrors({
        issue_date: 'Hay un cobro anterior a esta fecha de emisión.',
      });
    case 'INVOICE_IN_CLAIM':
      return {
        summary:
          'Esta factura está en una reclamación y ya no admite cambios. Cancela la reclamación para poder editarla.',
        fields: {},
      };
    case 'INVOICE_LIMIT_REACHED':
      return {
        summary:
          'Has llegado al máximo de facturas de la cuenta. Borra alguna que ya no necesites.',
        fields: {},
      };
    case 'DEBTOR_NOT_FOUND':
      return {
        summary:
          'No encontramos ese deudor. Recarga la página y elígelo otra vez.',
        fields: {},
      };
    default:
      return errorsFromFailure(failure, FIELDS);
  }
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wrap panel-page">
      <title>{title}</title>
      <Link className="back" to="/panel">
        <span aria-hidden="true">←</span> Ver todas las facturas
      </Link>
      {children}
    </div>
  );
}

function LoadError({
  failure,
  onRetry,
}: {
  failure: Failure;
  onRetry: () => void;
}) {
  return (
    <Frame title="Error al cargar · Reclama">
      <div className="card state error" role="alert">
        <h1>No hemos podido cargar los datos</h1>
        <p>{failureMessage(failure)}</p>
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      </div>
    </Frame>
  );
}

function Loading() {
  return (
    <Frame title="Factura · Reclama">
      <div className="card state" role="status">
        <span className="sr-only">Cargando…</span>
        <div className="skeleton" aria-hidden />
      </div>
    </Frame>
  );
}

interface FormProps {
  // Present when editing: the debtor cannot change then.
  invoice?: InvoiceDetail;
  debtors: Debtor[];
  debtorName?: string;
}

function InvoiceFormBody({ invoice, debtors, debtorName }: FormProps) {
  const editing = invoice !== undefined;
  const navigate = useNavigate();
  const { busy, run } = useBusy();
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useFocusOnErrors(errors, form);

  const [debtorChoice, setDebtorChoice] = useState(
    debtors.length === 0 ? NEW_DEBTOR : '',
  );
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [email, setEmail] = useState('');
  const [number, setNumber] = useState(invoice?.number ?? '');
  const [issueDate, setIssueDate] = useState(invoice?.issue_date ?? '');
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? '');
  const [amount, setAmount] = useState(
    invoice === undefined ? '' : centsToInput(invoice.amount_cents),
  );

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const fields: Record<string, string> = {};
      const cleanEmail = email.trim().toLowerCase();
      if (!editing) {
        if (debtorChoice === '') fields.debtor_id = 'Elige un deudor.';
        if (debtorChoice === NEW_DEBTOR) {
          if (name.trim() === '') {
            fields['debtor.name'] = 'Escribe el nombre del deudor.';
          }
          if (
            cleanEmail !== '' &&
            (cleanEmail.length > EMAIL_MAX_LENGTH ||
              !EMAIL_PATTERN.test(cleanEmail))
          ) {
            fields['debtor.email'] = EMAIL_INVALID_MESSAGE;
          }
        }
      }
      if (number.trim() === '') fields.number = 'Escribe el número de factura.';
      if (issueDate === '') fields.issue_date = 'Elige la fecha de emisión.';
      if (dueDate !== '' && issueDate !== '' && dueDate < issueDate) {
        fields.due_date = 'El vencimiento no puede ser anterior a la emisión.';
      }
      const money = parseMoney(amount);
      if (!money.ok) {
        fields.amount_cents = moneyErrorMessage(
          money.error,
          'Escribe el importe de la factura.',
        );
      }
      if (!money.ok || Object.keys(fields).length > 0) {
        setErrors(withFieldErrors(fields));
        return;
      }
      setErrors(NO_ERRORS);

      const common = {
        number: number.trim(),
        issue_date: issueDate,
        amount_cents: money.cents,
      };
      const result = editing
        ? await api<{ invoice: InvoiceDetail }>(
            'PATCH',
            `/api/invoices/${encodeURIComponent(invoice.id)}`,
            { ...common, due_date: dueDate === '' ? null : dueDate },
          )
        : await api<{ invoice: InvoiceDetail }>('POST', '/api/invoices', {
            ...common,
            ...(dueDate === '' ? {} : { due_date: dueDate }),
            ...(debtorChoice === NEW_DEBTOR
              ? {
                  debtor: {
                    name: name.trim(),
                    ...(taxId.trim() === '' ? {} : { tax_id: taxId.trim() }),
                    ...(cleanEmail === '' ? {} : { email: cleanEmail }),
                  },
                }
              : { debtor_id: debtorChoice }),
          });
      if (!result.ok) {
        setErrors(invoiceErrors(result));
        return;
      }
      void navigate(`/facturas/${result.data.invoice.id}`);
    });
  }

  return (
    <form
      ref={form}
      className="form"
      noValidate
      aria-busy={busy}
      aria-labelledby="factura-titulo"
      onSubmit={submit}
    >
      <ErrorSummary errors={errors} labels={LABELS} />
      {editing ? (
        <p className="note">
          Deudor: <b>{debtorName ?? '…'}</b>. El deudor de una factura no se
          puede cambiar.
        </p>
      ) : (
        <>
          <SelectField
            label="Deudor"
            name="debtor_id"
            value={debtorChoice}
            onChange={(event) => {
              setDebtorChoice(event.target.value);
            }}
            error={errors.fields.debtor_id}
          >
            <option value="">Elige un deudor…</option>
            {debtors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.tax_id ? ` (${d.tax_id})` : ''}
              </option>
            ))}
            <option value={NEW_DEBTOR}>Nuevo deudor…</option>
          </SelectField>
          {debtorChoice === NEW_DEBTOR ? (
            <>
              <TextField
                label="Nombre o razón social del deudor"
                name="debtor_name"
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                error={errors.fields['debtor.name']}
              />
              <TextField
                label="NIF o CIF del deudor (opcional)"
                name="debtor_tax_id"
                autoComplete="off"
                value={taxId}
                onChange={(event) => {
                  setTaxId(event.target.value);
                }}
                error={errors.fields['debtor.tax_id']}
              />
              <TextField
                label="Email del deudor (opcional)"
                name="debtor_email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                error={errors.fields['debtor.email']}
              />
            </>
          ) : null}
        </>
      )}
      <TextField
        label="Número de factura"
        name="number"
        autoComplete="off"
        value={number}
        onChange={(event) => {
          setNumber(event.target.value);
        }}
        error={errors.fields.number}
      />
      <TextField
        label="Fecha de emisión"
        name="issue_date"
        type="date"
        value={issueDate}
        onChange={(event) => {
          setIssueDate(event.target.value);
        }}
        error={errors.fields.issue_date}
      />
      <TextField
        label="Fecha de vencimiento (opcional)"
        name="due_date"
        type="date"
        hint="Si la dejas vacía, Reclama estima 30 días desde la emisión."
        value={dueDate}
        onChange={(event) => {
          setDueDate(event.target.value);
        }}
        error={errors.fields.due_date}
      />
      <TextField
        label="Importe (€)"
        name="amount_cents"
        inputMode="decimal"
        autoComplete="off"
        hint="Por ejemplo 1.234,56"
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
        }}
        error={errors.fields.amount_cents}
      />
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear factura'}
      </button>
    </form>
  );
}

export function NewInvoice() {
  const debtors = useLoad('debtors', loadDebtors);
  if (debtors.result === null) return <Loading />;
  if (!debtors.result.ok) {
    return <LoadError failure={debtors.result} onRetry={debtors.reload} />;
  }
  return (
    <Frame title="Nueva factura · Reclama">
      <div className="head">
        <h1 id="factura-titulo">Nueva factura</h1>
      </div>
      <InvoiceFormBody debtors={[...debtors.result.data.values()]} />
    </Frame>
  );
}

export function EditInvoice() {
  const { id = '' } = useParams();
  const url = `/api/invoices/${encodeURIComponent(id)}`;
  const invoice = useLoad<{ invoice: InvoiceDetail }>(url, () =>
    api<{ invoice: InvoiceDetail }>('GET', url),
  );
  const debtorId =
    invoice.result?.ok === true ? invoice.result.data.invoice.debtor_id : null;
  const debtorUrl =
    debtorId === null ? null : `/api/debtors/${encodeURIComponent(debtorId)}`;
  const debtor = useLoad<{ debtor: Debtor }>(debtorUrl, () =>
    api<{ debtor: Debtor }>('GET', debtorUrl ?? ''),
  );

  if (invoice.result === null) return <Loading />;
  if (!invoice.result.ok) {
    if (invoice.result.kind === 'not_found') {
      return (
        <Frame title="Factura no encontrada · Reclama">
          <div className="card state">
            <h1>No encontramos esta factura</h1>
            <p>Puede que se haya borrado o que el enlace no sea correcto.</p>
          </div>
        </Frame>
      );
    }
    return <LoadError failure={invoice.result} onRetry={invoice.reload} />;
  }
  const data = invoice.result.data.invoice;
  return (
    <Frame title={`Editar factura ${data.number} · Reclama`}>
      <div className="head">
        <h1 id="factura-titulo">Editar factura {data.number}</h1>
      </div>
      <InvoiceFormBody
        invoice={data}
        debtors={[]}
        {...(debtor.result?.ok === true
          ? { debtorName: debtor.result.data.debtor.name }
          : {})}
      />
    </Frame>
  );
}
