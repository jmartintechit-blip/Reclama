import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type SubmitEvent,
} from 'react';
import { Link } from 'react-router';
import { ErrorSummary } from '../components/Field.tsx';
import { IssueTable } from '../components/IssueTable.tsx';
import { IMPORT_COLUMNS } from '../content/import-columns.ts';
import { api, type Failure } from '../lib/api.ts';
import type { ImportOutcome } from '../lib/api-types.ts';
import {
  describeImportError,
  fileProblem,
  fileToBase64,
  formatFileSize,
  isFileProblem,
  MAX_CSV_ROWS,
  UNREADABLE_MESSAGE,
} from '../lib/csv-upload.ts';
import { formatCount, formatDate, formatEUR } from '../lib/format.ts';
import {
  NO_ERRORS,
  useBusy,
  useFocusOnErrors,
  type FormErrors,
} from '../lib/forms.ts';

// web/public/facturas-ejemplo.csv is a copy of data/sample-invoices.csv, kept equal by a test in
// server/domain. It is a static file, so the link needs no API call and works offline of the API.
const SAMPLE_CSV = '/facturas-ejemplo.csv';

type Screen =
  | { step: 'choose' }
  | { step: 'review'; preview: ImportOutcome }
  // The file cannot be imported as it is: the person has to fix it or pick another one.
  | { step: 'blocked'; errors: FormErrors }
  | { step: 'done'; result: ImportOutcome };

const STEP_LABELS = ['Elegir archivo', 'Revisar', 'Resultado'];
const STEP_INDEX = { choose: 0, review: 1, blocked: 1, done: 2 } as const;
const HEADINGS = {
  choose: 'Elige el archivo',
  review: 'Revisa lo que se va a importar',
  blocked: 'Este archivo no se puede importar',
  done: 'Importación terminada',
};

const count = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

function skippedRows(outcome: ImportOutcome): number {
  return new Set(outcome.errors.map((issue) => issue.row)).size;
}

// "Se crearían 3 deudores y 11 facturas; 2 ya estaban importadas y se saltarán."
function previewSentence(o: ImportOutcome): string {
  const already = o.invoices_already_imported;
  return `Se crearían ${count(o.debtors_created, 'deudor', 'deudores')} y ${count(o.invoices_created, 'factura', 'facturas')}${
    already > 0
      ? `; ${already === 1 ? '1 ya estaba importada y se saltará' : `${formatCount(already)} ya estaban importadas y se saltarán`}`
      : ''
  }.`;
}

function doneSentence(o: ImportOutcome): string {
  const already = o.invoices_already_imported;
  return `Se han creado ${count(o.debtors_created, 'deudor', 'deudores')} y ${count(o.invoices_created, 'factura', 'facturas')}${
    already > 0
      ? `; ${already === 1 ? '1 ya estaba importada y se ha saltado' : `${formatCount(already)} ya estaban importadas y se han saltado`}`
      : ''
  }.`;
}

// Why there is nothing to confirm, or null when there is.
function nothingToCreate(o: ImportOutcome): string | null {
  if (o.invoices_created > 0) return null;
  return o.rows_valid === 0
    ? 'Ninguna fila es válida, así que no hay nada que importar. Corrige los errores y vuelve a subir el archivo.'
    : 'Todas las facturas válidas del archivo ya estaban importadas, así que no hay nada nuevo que crear.';
}

function StepList({ current }: { current: number }) {
  return (
    <ol className="wizard-steps" aria-label="Pasos de la importación">
      {STEP_LABELS.map((label, index) => (
        <li
          key={label}
          className={index < current ? 'done' : undefined}
          aria-current={index === current ? 'step' : undefined}
        >
          <span className="num" aria-hidden="true">
            {index < current ? '✓' : index + 1}
          </span>
          {label}
          {index < current ? <span className="sr-only"> (hecho)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function FormatHelp() {
  return (
    <section className="format-help" aria-labelledby="formato-titulo">
      <h3 id="formato-titulo">Qué debe tener el archivo</h3>
      <ul>
        <li>
          Un CSV con una primera fila con los nombres de las columnas y una
          factura por fila. Las columnas pueden ir en cualquier orden.
        </li>
        <li>
          El separador puede ser punto y coma (;), coma (,) o tabulador: se
          detecta solo.
        </li>
        <li>
          Fechas como dd/mm/aaaa o aaaa-mm-dd. También se entienden dd-mm-aaaa y
          dd.mm.aaaa.
        </li>
        <li>
          Importes con coma decimal, como 1.234,56 o 1234,56. Se admite el
          símbolo €.
        </li>
        <li>
          Hasta 1 MB y {formatCount(MAX_CSV_ROWS)} facturas por archivo. Las
          tildes y la ñ funcionan tanto si el archivo es UTF-8 como si lo guardó
          Excel en español.
        </li>
        <li>
          ¿Tienes un archivo de Excel (.xlsx)? Ábrelo y elige Archivo &gt;
          Guardar como &gt; «CSV (delimitado por comas)».
        </li>
      </ul>
      <div className="card">
        <div className="table-wrapper">
          <table>
            <caption>
              Columnas que se entienden
              <small>
                Da igual si van en mayúsculas o con tilde. Cada columna puede
                llamarse como quieras de la lista.
              </small>
            </caption>
            <thead>
              <tr>
                <th scope="col">Columna</th>
                <th scope="col">Obligatoria</th>
                <th scope="col">También se entiende como</th>
              </tr>
            </thead>
            <tbody>
              {IMPORT_COLUMNS.map((column) => (
                <tr key={column.field}>
                  <th scope="row">{column.title}</th>
                  <td data-label="Obligatoria">
                    {column.required ? 'Sí' : 'No'}
                  </td>
                  <td data-label="También se entiende como">
                    {column.aliases.join(', ')}
                    {column.note ? <small>{column.note}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p>
        <a href={SAMPLE_CSV} download>
          Descargar un CSV de ejemplo
        </a>
      </p>
    </section>
  );
}

function ChooseStep({
  busy,
  onReview,
}: {
  busy: boolean;
  onReview: (file: File) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  function choose(candidate: File | undefined) {
    const found = candidate ? fileProblem(candidate) : null;
    setProblem(found);
    setFile(candidate && found === null ? candidate : null);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (!dropped) return;
    try {
      // So the input shows the same file as the rest of the screen.
      if (input.current) input.current.files = event.dataTransfer.files;
    } catch {
      // Not every browser lets a script set the files; the drop itself still works.
    }
    choose(dropped);
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null) {
      setProblem(problem ?? 'Elige un archivo CSV.');
      input.current?.focus();
      return;
    }
    onReview(file);
  }

  return (
    <>
      <form className="form" noValidate aria-busy={busy} onSubmit={submit}>
        {/* The drop zone only adds a second way in: the file input inside it works on its own. */}
        <div
          className={`field dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={drop}
        >
          <label htmlFor={id}>Archivo CSV</label>
          <p id={`${id}-hint`} className="hint">
            Elígelo en tu equipo o arrástralo hasta aquí.
          </p>
          <input
            ref={input}
            id={id}
            type="file"
            accept=".csv,text/csv"
            className="input"
            aria-describedby={problem ? `${id}-hint ${id}-error` : `${id}-hint`}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              choose(event.target.files?.[0]);
            }}
          />
          <div role="alert">
            {problem ? (
              <p id={`${id}-error`} className="field-error">
                {problem}
              </p>
            ) : null}
          </div>
        </div>
        <p className="file-chosen" role="status">
          {file
            ? `Archivo elegido: ${file.name} (${formatFileSize(file.size)}).`
            : ''}
        </p>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Revisando…' : 'Revisar archivo'}
          </button>
        </div>
      </form>
      <FormatHelp />
    </>
  );
}

function PreviewTable({ outcome }: { outcome: ImportOutcome }) {
  const rows = outcome.preview ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <div className="table-wrapper">
        <table>
          <caption>
            Así se han leído las primeras facturas
            <small>
              Comprueba que las fechas, los importes y las tildes son los que
              esperas. Importes en euros.
              {rows.length < outcome.rows_valid
                ? ` Se muestran ${formatCount(rows.length)} de ${formatCount(outcome.rows_valid)}.`
                : ''}
            </small>
          </caption>
          <thead>
            <tr>
              <th scope="col">Factura</th>
              <th scope="col">Cliente</th>
              <th scope="col">Emisión</th>
              <th scope="col">Vencimiento</th>
              <th scope="col" className="r">
                Importe
              </th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row}>
                <th scope="row">{row.number}</th>
                <td data-label="Cliente">{row.debtor_name}</td>
                <td data-label="Emisión">
                  <span className="amt">{formatDate(row.issue_date)}</span>
                </td>
                <td data-label="Vencimiento">
                  {row.due_date ? (
                    <span className="amt">{formatDate(row.due_date)}</span>
                  ) : (
                    'Sin fecha'
                  )}
                </td>
                <td data-label="Importe" className="r">
                  <span className="amt">{formatEUR(row.amount_cents)}</span>
                </td>
                <td data-label="Estado">
                  {row.already_imported ? 'Ya importada: se salta' : 'Nueva'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FileLine({ file }: { file: { name: string; size: number } | null }) {
  if (!file) return null;
  return (
    <p className="file-line">
      Archivo: <b>{file.name}</b> ({formatFileSize(file.size)})
    </p>
  );
}

function ReviewStep({
  preview,
  file,
  busy,
  onConfirm,
  onBack,
}: {
  preview: ImportOutcome;
  file: { name: string; size: number } | null;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const reason = nothingToCreate(preview);
  const skipped = skippedRows(preview);
  const reasonId = useId();
  return (
    <>
      <FileLine file={file} />
      <p className="import-summary">{previewSentence(preview)}</p>
      {skipped > 0 && reason === null ? (
        <p>
          {skipped === 1
            ? '1 fila tiene errores y se saltará.'
            : `${formatCount(skipped)} filas tienen errores y se saltarán.`}{' '}
          Puedes continuar con las demás o elegir otro archivo y corregirlo.
        </p>
      ) : null}
      {reason ? (
        <p id={reasonId} className="notice">
          {reason}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || reason !== null}
          aria-describedby={reason ? reasonId : undefined}
          onClick={onConfirm}
        >
          {busy ? 'Importando…' : 'Confirmar importación'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onBack}>
          Elegir otro archivo
        </button>
      </div>
      {preview.errors.length > 0 ? (
        <IssueTable
          title="Filas con errores"
          note="Estas filas no se importan. Corrígelas en el archivo y vuelve a subirlo."
          issues={preview.errors}
        />
      ) : null}
      {preview.warnings.length > 0 ? (
        <IssueTable
          title="Avisos"
          note="No impiden importar, pero conviene echarles un vistazo."
          issues={preview.warnings}
        />
      ) : null}
      <PreviewTable outcome={preview} />
    </>
  );
}

function DoneStep({
  result,
  onAgain,
}: {
  result: ImportOutcome;
  onAgain: () => void;
}) {
  const skipped = skippedRows(result);
  return (
    <>
      <p className="import-summary">{doneSentence(result)}</p>
      {skipped > 0 ? (
        <p>
          {skipped === 1
            ? '1 fila con errores no se ha importado.'
            : `${formatCount(skipped)} filas con errores no se han importado.`}
        </p>
      ) : null}
      <div className="actions">
        <Link className="btn primary" to="/panel">
          Ver mis facturas
        </Link>
        <button type="button" className="btn" onClick={onAgain}>
          Importar otro archivo
        </button>
      </div>
    </>
  );
}

const send = (csvBase64: string, dryRun: boolean) =>
  api<ImportOutcome>('POST', '/api/imports', {
    csv_base64: csvBase64,
    dry_run: dryRun,
  });

export function ImportCsv() {
  const [screen, setScreen] = useState<Screen>({ step: 'choose' });
  // A hiccup (no connection, too many attempts...) that leaves the person where they were.
  const [notice, setNotice] = useState<FormErrors>(NO_ERRORS);
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(
    null,
  );
  // The file as it was sent for the dry run. Confirming sends these same bytes, so the person is
  // never asked for the file twice, and a file edited in the meantime cannot differ from the
  // preview they just approved.
  const payload = useRef<string | null>(null);
  const { busy, run } = useBusy();
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(screen.step);
  const headingId = useId();

  // Each step has its own heading and focus moves to it, so the keyboard and the screen reader
  // follow the change. A blocked file moves focus to the error instead (useFocusOnErrors).
  useEffect(() => {
    if (shownStep.current === screen.step) return;
    shownStep.current = screen.step;
    if (screen.step !== 'blocked') heading.current?.focus();
  }, [screen.step]);
  const errors = screen.step === 'blocked' ? screen.errors : notice;
  useFocusOnErrors(errors, root);

  function go(next: Screen) {
    setNotice(NO_ERRORS);
    setScreen(next);
  }

  function fail(failure: Failure) {
    const summary = describeImportError(failure);
    if (isFileProblem(failure)) {
      go({ step: 'blocked', errors: { summary, fields: {} } });
    } else {
      setNotice({ summary, fields: {} });
    }
  }

  function review(file: File) {
    void run(async () => {
      setNotice(NO_ERRORS);
      setChosen({ name: file.name, size: file.size });
      let base64: string;
      try {
        base64 = await fileToBase64(file);
      } catch {
        // The file moved, was deleted or changed on disk after it was chosen.
        go({
          step: 'blocked',
          errors: { summary: UNREADABLE_MESSAGE, fields: {} },
        });
        return;
      }
      const result = await send(base64, true);
      if (!result.ok) {
        fail(result);
        return;
      }
      payload.current = base64;
      go({ step: 'review', preview: result.data });
    });
  }

  function confirm() {
    void run(async () => {
      if (payload.current === null) return;
      setNotice(NO_ERRORS);
      const result = await send(payload.current, false);
      if (!result.ok) {
        fail(result);
        return;
      }
      payload.current = null;
      go({ step: 'done', result: result.data });
    });
  }

  function chooseAnother() {
    payload.current = null;
    setChosen(null);
    go({ step: 'choose' });
  }

  let body;
  let announcement = '';
  switch (screen.step) {
    case 'choose':
      body = <ChooseStep busy={busy} onReview={review} />;
      break;
    case 'review':
      announcement = `Revisión lista. ${previewSentence(screen.preview)}`;
      body = (
        <ReviewStep
          preview={screen.preview}
          file={chosen}
          busy={busy}
          onConfirm={confirm}
          onBack={chooseAnother}
        />
      );
      break;
    case 'blocked':
      body = (
        <>
          <FileLine file={chosen} />
          <p>No se ha importado nada. Corrige el archivo o elige otro.</p>
          <div className="actions">
            <button
              type="button"
              className="btn primary"
              onClick={chooseAnother}
            >
              Elegir otro archivo
            </button>
          </div>
        </>
      );
      break;
    case 'done':
      announcement = `Importación terminada. ${doneSentence(screen.result)}`;
      body = <DoneStep result={screen.result} onAgain={chooseAnother} />;
      break;
  }

  return (
    <div className="wrap panel-page import-page" aria-busy={busy}>
      <title>Importar facturas · Reclama</title>
      <div className="head">
        <div>
          <h1>Importar facturas</h1>
          <p>
            Sube el CSV que exporta tu programa de facturación. Antes de crear
            nada verás un resumen para confirmarlo.
          </p>
        </div>
      </div>
      <StepList current={STEP_INDEX[screen.step]} />
      <div role="status" className="sr-only">
        {announcement}
      </div>
      <section ref={root} className="panel" aria-labelledby={headingId}>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          {HEADINGS[screen.step]}
        </h2>
        <ErrorSummary errors={errors} labels={{}} />
        {body}
      </section>
    </div>
  );
}
