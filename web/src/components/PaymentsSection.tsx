import { useRef, useState, type SubmitEvent } from 'react';
import { api, type Failure } from '../lib/api.ts';
import type { InvoiceDetail } from '../lib/api-types.ts';
import { formatDate, formatEUR } from '../lib/format.ts';
import {
  errorsFromFailure,
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import { moneyErrorMessage, parseMoney } from '../lib/money.ts';
import { ErrorSummary, TextField } from './Field.tsx';

const LABELS = { paid_on: 'Fecha del cobro', amount_cents: 'Importe cobrado' };
const FIELDS = ['paid_on', 'amount_cents'] as const;

// The server's business errors, in Spanish and next to the field they are about.
function paymentErrors(failure: Failure): FormErrors {
  const extra = failure.extra ?? {};
  switch (failure.code) {
    case 'PAYMENT_EXCEEDS_BALANCE': {
      const remaining = extra.remaining_cents;
      return withFieldErrors({
        amount_cents:
          typeof remaining === 'number' && Number.isSafeInteger(remaining)
            ? `Es más de lo que falta por cobrar: quedan ${formatEUR(remaining)}.`
            : 'Es más de lo que falta por cobrar.',
      });
    }
    case 'PAYMENT_IN_FUTURE':
      return withFieldErrors({
        paid_on: 'La fecha del cobro no puede ser futura.',
      });
    case 'PAYMENT_BEFORE_ISSUE':
      return withFieldErrors({
        paid_on: 'La fecha del cobro no puede ser anterior a la emisión.',
      });
    case 'INVOICE_FULLY_PAID':
      return {
        summary: 'La factura ya está cobrada por completo.',
        fields: {},
      };
    case 'PAYMENT_LIMIT_REACHED': {
      const limit = extra.limit;
      return {
        summary: `Esta factura ya tiene el máximo de cobros registrados${typeof limit === 'number' ? ` (${String(limit)})` : ''}.`,
        fields: {},
      };
    }
    case 'INVOICE_IN_CLAIM':
      return {
        summary: 'Esta factura está en una reclamación y ya no admite cambios.',
        fields: {},
      };
    default:
      return errorsFromFailure(failure, FIELDS);
  }
}

function PaymentForm({
  invoice,
  today,
  onRecorded,
}: {
  invoice: InvoiceDetail;
  today: string;
  onRecorded: () => void;
}) {
  const { busy, run } = useBusy();
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saved, setSaved] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useFocusOnErrors(errors, form);
  const paid = invoice.status === 'PAID';

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      setSaved(false);
      const fields: Record<string, string> = {};
      if (date === '') fields.paid_on = 'Elige la fecha del cobro.';
      const money = parseMoney(amount);
      if (!money.ok) fields.amount_cents = moneyErrorMessage(money.error);
      if (!money.ok || Object.keys(fields).length > 0) {
        setErrors(withFieldErrors(fields));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api('POST', `/api/invoices/${invoice.id}/payments`, {
        paid_on: date,
        amount_cents: money.cents,
      });
      if (!result.ok) {
        setErrors(paymentErrors(result));
        // The invoice may have changed under us (settled in another tab): show how it is now.
        if (result.code === 'INVOICE_FULLY_PAID') onRecorded();
        return;
      }
      setAmount('');
      setDate(today);
      setSaved(true);
      onRecorded();
    });
  }

  return (
    <form
      ref={form}
      className="form pay-form"
      noValidate
      aria-busy={busy}
      aria-labelledby="cobro-titulo"
      onSubmit={submit}
    >
      <h3 id="cobro-titulo">Añadir cobro</h3>
      {paid ? (
        <p className="hint">
          La factura está cobrada por completo: no admite más cobros.
        </p>
      ) : null}
      <ErrorSummary errors={errors} labels={LABELS} />
      <div className="pay-fields">
        <TextField
          label="Fecha del cobro"
          name="paid_on"
          type="date"
          min={invoice.issue_date}
          max={today}
          disabled={paid}
          hint="Hasta hoy."
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
          error={errors.fields.paid_on}
        />
        <TextField
          label="Importe cobrado (€)"
          name="amount_cents"
          inputMode="decimal"
          autoComplete="off"
          disabled={paid}
          hint="Por ejemplo 1.234,56"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          error={errors.fields.amount_cents}
        />
      </div>
      <div role="status" className="form-ok">
        {saved ? <p>Cobro registrado.</p> : null}
      </div>
      <button type="submit" className="btn primary" disabled={busy || paid}>
        {busy ? 'Guardando…' : 'Añadir cobro'}
      </button>
    </form>
  );
}

export function PaymentsSection({
  invoice,
  today,
  onRecorded,
}: {
  invoice: InvoiceDetail;
  today: string;
  onRecorded: () => void;
}) {
  const payments = [...invoice.payments].sort((a, b) =>
    a.paid_on.localeCompare(b.paid_on),
  );
  return (
    <section className="panel" aria-labelledby="cobros-titulo">
      <h2 id="cobros-titulo">Cobros</h2>
      {payments.length === 0 ? (
        <p className="note">Todavía no hay cobros registrados.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <caption>Cobros registrados en esta factura</caption>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col" className="r">
                  Importe
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <th scope="row">{formatDate(payment.paid_on)}</th>
                  <td className="r amt">{formatEUR(payment.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PaymentForm invoice={invoice} today={today} onRecorded={onRecorded} />
    </section>
  );
}
