import type { Failure } from '../lib/api.ts';
import type { Interest, InvoiceDetail } from '../lib/api-types.ts';
import {
  formatDate,
  formatEUR,
  formatRate,
  formatSemester,
} from '../lib/format.ts';
import { failureMessage } from '../lib/messages.ts';
import { interestToTimeline } from '../lib/invoice-timeline.ts';
import { TextField } from './Field.tsx';
import { Timeline } from './Timeline.tsx';

export const MIN_AS_OF = '1990-01-01';
const MAX_NAMED_SEMESTERS = 4;

// Why a calculation date cannot be used, or null when it can. An empty field means "today".
export function asOfProblem(asOf: string, today: string): string | null {
  if (asOf === '') return null;
  if (asOf > today) return 'La fecha de cálculo no puede ser futura.';
  if (asOf < MIN_AS_OF) return 'Elige una fecha a partir de 1990.';
  return null;
}

function semesterList(codes: unknown): string {
  const names = (Array.isArray(codes) ? codes : [])
    .filter((code): code is string => typeof code === 'string')
    .map(formatSemester);
  if (names.length === 0) return 'algunos semestres';
  if (names.length > MAX_NAMED_SEMESTERS) {
    const rest = names.length - MAX_NAMED_SEMESTERS;
    return `${names.slice(0, MAX_NAMED_SEMESTERS).join(', ')} y ${String(rest)} más`;
  }
  return names.length === 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} y ${names.at(-1) ?? ''}`;
}

function InterestError({
  failure,
  retrying,
  onRetry,
}: {
  failure: Failure;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (failure.code === 'RATE_WINDOW') {
    return (
      <div className="notice" role="alert">
        <p>
          <b>No podemos calcular estos intereses.</b> Faltan los tipos de demora
          del BOE de estos semestres:{' '}
          {semesterList(failure.extra?.missing_semesters)}. Reclama no extrapola
          ni estima tipos: solo calcula con los que ya son oficiales y tiene
          cargados.
        </p>
      </div>
    );
  }
  if (failure.code === 'CALCULATION_FAILED') {
    return (
      <div className="notice" role="alert">
        <p>
          No hemos podido calcular los intereses de esta factura. Revisa sus
          fechas y sus cobros.
        </p>
      </div>
    );
  }
  return (
    <div className="notice" role="alert">
      <p>{failureMessage(failure)}</p>
      <button
        type="button"
        className="btn"
        disabled={retrying}
        onClick={onRetry}
      >
        Reintentar
      </button>
    </div>
  );
}

function Breakdown({
  interest,
  invoice,
}: {
  interest: Interest;
  invoice: InvoiceDetail;
}) {
  const due = formatDate(interest.due_date_effective);
  if (interest.segments.length === 0) {
    return (
      <p className="notice calm">
        {interest.as_of <= interest.due_date_effective
          ? `Todavía no hay intereses: la factura vence el ${due}.`
          : 'No hay intereses: la factura estaba cobrada por completo cuando venció.'}
      </p>
    );
  }
  const input = interestToTimeline(interest, invoice.payments);
  return (
    <>
      <Timeline {...input} />
      <div className="tablewrap">
        <table>
          <caption>Los mismos tramos en forma de tabla</caption>
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
            {interest.segments.map((segment) => (
              <tr key={segment.start}>
                <td>{formatDate(segment.start)}</td>
                <td>{formatDate(segment.end)}</td>
                <td className="r amt">{String(segment.days)}</td>
                <td className="r amt">{formatRate(segment.rate_bp)}</td>
                <td className="r amt">{formatEUR(segment.balance_cents)}</td>
                <td className="r amt">{formatEUR(segment.interest_cents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={5}>
                Total
              </th>
              <td className="r amt">{formatEUR(interest.interest_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

export function InterestSection({
  invoice,
  result,
  retrying,
  onRetry,
  today,
  asOf,
  onAsOfChange,
}: {
  invoice: InvoiceDetail;
  // null while the first answer is on its way.
  result: { ok: true; data: Interest } | Failure | null;
  retrying: boolean;
  onRetry: () => void;
  today: string;
  asOf: string;
  onAsOfChange: (value: string) => void;
}) {
  const problem = asOfProblem(asOf, today);
  const shown = result?.ok ? result.data : null;
  return (
    <section
      className="panel"
      aria-labelledby="desglose-titulo"
      aria-busy={retrying}
    >
      <h2 id="desglose-titulo">
        Desglose de intereses
        {shown ? ` a ${formatDate(shown.as_of)}` : ''}
      </h2>
      <div className="asof">
        <TextField
          label="Calcular a otra fecha"
          type="date"
          min={MIN_AS_OF}
          max={today}
          value={asOf}
          onChange={(event) => {
            onAsOfChange(event.target.value);
          }}
          error={problem ?? undefined}
          hint="Por defecto, hoy."
        />
        {asOf !== '' ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onAsOfChange('');
            }}
          >
            Volver a hoy
          </button>
        ) : null}
      </div>
      {result === null ? (
        <div className="state" role="status">
          <span className="sr-only">Calculando los intereses…</span>
          <div className="skeleton" aria-hidden />
          <div className="skeleton" style={{ inlineSize: '80%' }} aria-hidden />
        </div>
      ) : result.ok ? (
        <>
          <Breakdown interest={result.data} invoice={invoice} />
          {result.data.warnings.includes('TERM_OVER_60_DAYS') ? (
            <p className="notice">
              El plazo entre la emisión y el vencimiento supera los 60 días de
              plazo máximo que prevé la Ley 3/2004. Revísalo antes de reclamar.
            </p>
          ) : null}
        </>
      ) : (
        <InterestError failure={result} retrying={retrying} onRetry={onRetry} />
      )}
      <p className="note">
        {invoice.agreed_rate_bp === null
          ? 'El tipo es el del BOE de cada semestre natural: se calcula cada tramo con el tipo vigente en su semestre. Un cobro parcial reduce el saldo desde el día siguiente.'
          : `Esta factura tiene un tipo pactado del ${formatRate(invoice.agreed_rate_bp)}: se aplica ese tipo en todos los tramos. Un cobro parcial reduce el saldo desde el día siguiente.`}{' '}
        Los tipos de interés proceden del BOE.
      </p>
    </section>
  );
}
