// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportOutcome, ImportRowIssue } from '../lib/api-types.ts';
import {
  debtor,
  debtorsPage,
  invoice,
  invoicesPage,
} from '../test/fixtures.ts';
import {
  apiError,
  deferred,
  empty,
  json,
  me,
  mockApi,
  networkError,
  UNAUTHENTICATED,
  type Reply,
} from '../test/mock-api.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const IMPORTS = 'POST /api/imports';
const SAMPLE = 'Factura;Cliente;Importe\nF-1;Muñoz y Peña S.L.;100,00\n';

// A reference encoder that shares nothing with the code under test.
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const utf8 = (text: string) => new TextEncoder().encode(text);

function csv(
  content: string | Uint8Array = SAMPLE,
  name = 'facturas.csv',
): { file: File; base64: string } {
  const bytes = typeof content === 'string' ? utf8(content) : content;
  return {
    file: new File([new Uint8Array(bytes)], name, { type: 'text/csv' }),
    base64: base64Of(bytes),
  };
}

const outcome = (overrides: Partial<ImportOutcome> = {}): ImportOutcome => ({
  dry_run: true,
  rows_total: 3,
  rows_valid: 3,
  debtors_created: 2,
  invoices_created: 3,
  invoices_already_imported: 0,
  errors: [],
  warnings: [],
  preview: [
    {
      row: 2,
      number: 'F-1',
      debtor_name: 'Muñoz y Peña S.L.',
      issue_date: '2026-01-15',
      due_date: '2026-02-14',
      amount_cents: 123_456,
      already_imported: false,
    },
    {
      row: 3,
      number: 'F-2',
      debtor_name: 'Talleres Ejemplo S.L.',
      issue_date: '2026-03-03',
      due_date: null,
      amount_cents: 245_000,
      already_imported: true,
    },
  ],
  ...overrides,
});
const dryRun = (overrides: Partial<ImportOutcome> = {}): Reply =>
  json(200, { data: outcome(overrides) });
const real = (overrides: Partial<ImportOutcome> = {}): Reply =>
  json(200, {
    data: outcome({ dry_run: false, preview: undefined, ...overrides }),
  });

const issue = (row: number, code = 'AMOUNT_NEGATIVE'): ImportRowIssue => ({
  row,
  field: 'amount',
  code,
  message: 'English message',
});
const manyIssues = (n: number) =>
  Array.from({ length: n }, (_, i) => issue(i + 2));

async function openImport(table: Record<string, Reply | Reply[]> = {}) {
  const mock = mockApi({ 'GET /api/me': me(), ...table });
  const router = renderApp('/importar');
  await screen.findByRole('heading', { level: 1, name: 'Importar facturas' });
  return { mock, router, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const fileInput = () => screen.getByLabelText<HTMLInputElement>('Archivo CSV');
const reviewButton = () =>
  screen.getByRole('button', { name: 'Revisar archivo' });
const stepHeading = (name: string) =>
  screen.findByRole('heading', { level: 2, name });
const stepItems = () =>
  within(
    screen.getByRole('list', { name: 'Pasos de la importación' }),
  ).getAllByRole('listitem');
const alert = () => document.querySelector<HTMLElement>('[data-error-summary]');

async function reviewFile(
  user: User,
  content?: string | Uint8Array,
  name?: string,
) {
  const sent = csv(content, name);
  await user.upload(fileInput(), sent.file);
  await user.click(reviewButton());
  return sent;
}

describe('Import: step 1, choosing the file', () => {
  it('shows the steps as an ordered list with the current one marked', async () => {
    await openImport();
    const list = screen.getByRole('list', { name: 'Pasos de la importación' });
    expect(list.tagName).toBe('OL');
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      '1Elegir archivo',
      '2Revisar',
      '3Resultado',
    ]);
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([
      'step',
      null,
      null,
    ]);
  });

  it('has a labelled file input that takes CSV, and a drop zone as an extra', async () => {
    await openImport();
    const input = fileInput();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.csv,text/csv');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.querySelector('.dropzone')?.contains(input)).toBe(true);
  });

  it('explains the format: columns with their aliases, separators, dates, amounts and limits', async () => {
    await openImport();
    const text = screen.getByRole('main').textContent;
    for (const part of [
      'punto y coma (;)',
      'coma (,) o tabulador',
      'dd/mm/aaaa o aaaa-mm-dd',
      '1.234,56',
      'Hasta 1 MB y 500 facturas',
      'Guardar como',
    ]) {
      expect(text).toContain(part);
    }
    const table = screen.getByRole('table', {
      name: /Columnas que se entienden/,
    });
    const row = within(table).getByRole('row', { name: /^Importe/ });
    expect(row.textContent).toContain(
      'Total, Importe total, Total factura, Amount',
    );
    expect(within(table).getAllByRole('row')).toHaveLength(8);
  });

  it('offers the sample CSV as a download of a static file', async () => {
    await openImport();
    const link = screen.getByRole('link', {
      name: 'Descargar un CSV de ejemplo',
    });
    expect(link.getAttribute('href')).toBe('/facturas-ejemplo.csv');
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('shows the name and size of the chosen file, politely announced', async () => {
    const { user } = await openImport();
    await user.upload(fileInput(), csv('a;b\n'.repeat(300), 'enero.csv').file);
    expect(
      screen
        .getByText(/Archivo elegido: enero.csv \(1,2 kB\)\./)
        .getAttribute('role'),
    ).toBe('status');
  });

  it('asks for a file when "Revisar archivo" is pressed with none, without calling the API', async () => {
    const { user, mock } = await openImport();
    await user.click(reviewButton());
    expect(screen.getByText('Elige un archivo CSV.')).toBeTruthy();
    expect(fileInput().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(fileInput());
    expect(mock.count(IMPORTS)).toBe(0);
  });

  it('refuses a file over 1 MB before sending anything', async () => {
    const { user, mock } = await openImport();
    await user.upload(
      fileInput(),
      csv(new Uint8Array(1_048_577), 'enorme.csv').file,
    );
    const problem = screen.getByText(
      'El archivo pesa más de 1 MB. Quita las columnas que no necesites o divídelo en varios archivos.',
    );
    expect(problem.closest('[role="alert"]')).toBeTruthy();
    expect(fileInput().getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/Archivo elegido/)).toBeNull();
    await user.click(reviewButton());
    expect(mock.count(IMPORTS)).toBe(0);
  });

  it('takes a file of exactly 1 MB', async () => {
    const { user } = await openImport();
    await user.upload(
      fileInput(),
      csv(new Uint8Array(1_048_576), 'justo.csv').file,
    );
    expect(screen.getByText(/Archivo elegido: justo.csv/)).toBeTruthy();
    expect(fileInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('refuses an Excel workbook and an empty file with a way out', async () => {
    const user = userEvent.setup({ applyAccept: false });
    mockApi({ 'GET /api/me': me() });
    renderApp('/importar');
    await screen.findByRole('heading', { level: 1, name: 'Importar facturas' });
    await user.upload(fileInput(), csv('x', 'datos.xlsx').file);
    const problem = () =>
      document.querySelector('.dropzone [role="alert"]')?.textContent;
    expect(problem()).toContain('Guardar como > «CSV');
    await user.upload(fileInput(), csv('', 'vacio.csv').file);
    expect(problem()).toBe('El archivo está vacío. Elige otro.');
  });

  it('accepts a file dropped on the zone', async () => {
    const { user, mock } = await openImport({ [IMPORTS]: dryRun() });
    const zone = document.querySelector<HTMLElement>('.dropzone');
    const sent = csv(SAMPLE, 'arrastrado.csv');
    fireEvent.dragOver(zone as HTMLElement);
    expect(zone?.className).toContain('dragging');
    fireEvent.drop(zone as HTMLElement, {
      dataTransfer: { files: [sent.file] },
    });
    expect(zone?.className).not.toContain('dragging');
    expect(screen.getByText(/Archivo elegido: arrastrado.csv/)).toBeTruthy();
    await user.click(reviewButton());
    await stepHeading('Revisa lo que se va a importar');
    expect(mock.lastBody(IMPORTS)).toEqual({
      csv_base64: sent.base64,
      dry_run: true,
    });
  });
});

describe('Import: the happy path', () => {
  it('sends a dry run, previews the counts, then confirms the same file', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: [
        dryRun({
          debtors_created: 2,
          invoices_created: 3,
          invoices_already_imported: 2,
        }),
        real({
          debtors_created: 2,
          invoices_created: 3,
          invoices_already_imported: 2,
        }),
      ],
    });
    const sent = await reviewFile(user);

    expect(mock.calls.filter((call) => call.key === IMPORTS)[0]?.body).toEqual({
      csv_base64: sent.base64,
      dry_run: true,
    });
    await stepHeading('Revisa lo que se va a importar');
    expect(
      screen.getByText(
        'Se crearían 2 deudores y 3 facturas; 2 ya estaban importadas y se saltarán.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('facturas.csv')).toBeTruthy();
    const steps = stepItems();
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([
      null,
      'step',
      null,
    ]);
    expect(steps[0]?.textContent).toContain('(hecho)');

    await user.click(
      screen.getByRole('button', { name: 'Confirmar importación' }),
    );
    await stepHeading('Importación terminada');
    expect(mock.count(IMPORTS)).toBe(2);
    expect(mock.lastBody(IMPORTS)).toEqual({
      csv_base64: sent.base64,
      dry_run: false,
    });
    expect(
      screen.getByText(
        'Se han creado 2 deudores y 3 facturas; 2 ya estaban importadas y se han saltado.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Ver mis facturas' })
        .getAttribute('href'),
    ).toBe('/panel');
    expect(
      stepItems().map((step) => step.getAttribute('aria-current')),
    ).toEqual([null, null, 'step']);
    // The file was asked for once: there is still a single input in the page, or none.
    expect(screen.queryByLabelText('Archivo CSV')).toBeNull();
  });

  it('uses singular and plural forms', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({
        debtors_created: 1,
        invoices_created: 1,
        invoices_already_imported: 1,
      }),
    });
    await reviewFile(user);
    expect(
      await screen.findByText(
        'Se crearían 1 deudor y 1 factura; 1 ya estaba importada y se saltará.',
      ),
    ).toBeTruthy();
  });

  it('announces the outcome in a polite live region', async () => {
    const { user } = await openImport({
      [IMPORTS]: [dryRun(), real()],
    });
    await reviewFile(user);
    await stepHeading('Revisa lo que se va a importar');
    const live = () =>
      screen
        .getAllByRole('status')
        .map((node) => node.textContent)
        .join('|');
    expect(live()).toContain(
      'Revisión lista. Se crearían 2 deudores y 3 facturas.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Confirmar importación' }),
    );
    await stepHeading('Importación terminada');
    expect(live()).toContain(
      'Importación terminada. Se han creado 2 deudores y 3 facturas.',
    );
  });

  it('sends the bytes of a windows-1252 file untouched', async () => {
    const bytes = Uint8Array.from([
      ...utf8('Factura;Cliente;Importe\nF-1;Mu'),
      0xf1,
      ...utf8('oz;100,00\nF-2;Jos'),
      0xe9,
      ...utf8(';5,00\n'),
    ]);
    const { user, mock } = await openImport({ [IMPORTS]: dryRun() });
    await reviewFile(user, bytes);
    await stepHeading('Revisa lo que se va a importar');
    const body = mock.lastBody(IMPORTS) as { csv_base64: string };
    expect(body.csv_base64).toBe(base64Of(bytes));
    expect([
      ...Uint8Array.from(atob(body.csv_base64), (c) => c.charCodeAt(0)),
    ]).toContain(0xf1);
  });

  it('moves focus to each step heading', async () => {
    const { user } = await openImport({ [IMPORTS]: [dryRun(), real()] });
    await reviewFile(user);
    const review = await stepHeading('Revisa lo que se va a importar');
    await waitFor(() => {
      expect(document.activeElement).toBe(review);
    });
    await user.click(
      screen.getByRole('button', { name: 'Confirmar importación' }),
    );
    const done = await stepHeading('Importación terminada');
    await waitFor(() => {
      expect(document.activeElement).toBe(done);
    });
  });

  it('shows the first rows as read, with accents, dates and amounts in Spanish format', async () => {
    const { user } = await openImport({ [IMPORTS]: dryRun() });
    await reviewFile(user);
    const table = await screen.findByRole('table', {
      name: /Así se han leído/,
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.getAttribute('scope')),
    ).toEqual(Array(6).fill('col'));
    const first = within(table).getByRole('row', { name: /F-1/ });
    expect(within(first).getByRole('rowheader').textContent).toBe('F-1');
    expect(first.textContent).toContain('Muñoz y Peña S.L.');
    expect(first.textContent).toContain('15/01/2026');
    expect(first.textContent).toContain('14/02/2026');
    expect(first.textContent).toContain('1.234,56');
    expect(first.textContent).toContain('Nueva');
    const second = within(table).getByRole('row', { name: /F-2/ });
    expect(second.textContent).toContain('Sin fecha');
    expect(second.textContent).toContain('Ya importada: se salta');
  });

  it('opens the dashboard with a fresh list after importing', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: [dryRun(), real()],
      'GET /api/invoices': json(
        200,
        invoicesPage([invoice({ number: 'F-NUEVA' })]),
      ),
      'GET /api/debtors?limit=100&offset=0': json(200, debtorsPage([debtor()])),
    });
    await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Confirmar importación' }),
    );
    await user.click(
      await screen.findByRole('link', { name: 'Ver mis facturas' }),
    );
    expect(await screen.findByText('F-NUEVA')).toBeTruthy();
    // Nothing is cached between screens: the list was asked for when it opened.
    expect(mock.count('GET /api/invoices')).toBe(1);
  });
});

describe('Import: row errors and warnings', () => {
  it('lists the row errors in an accessible table, in Spanish', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({
        rows_total: 5,
        errors: [
          { row: 4, field: 'issueDate', code: 'INVALID_DATE', message: 'x' },
          { row: 5, field: 'amount', code: 'AMOUNT_NEGATIVE', message: 'x' },
          { row: 5, field: null, code: 'NEW_RULE', message: 'Something new' },
        ],
      }),
    });
    await reviewFile(user);
    const table = await screen.findByRole('table', {
      name: /Filas con errores/,
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => [th.textContent, th.getAttribute('scope')]),
    ).toEqual([
      ['Fila', 'col'],
      ['Campo', 'col'],
      ['Problema', 'col'],
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toBe(
      '4Fecha de emisiónLa fecha no existe o no se entiende. Usa dd/mm/aaaa o aaaa-mm-dd.',
    );
    expect(rows[1]?.textContent).toContain('Importe');
    expect(rows[1]?.textContent).toContain('El importe no puede ser negativo.');
    // A code the app has no text for shows the server's message instead of nothing.
    expect(rows[2]?.textContent).toContain('Toda la fila');
    expect(rows[2]?.textContent).toContain('Something new');
    expect(within(table).getByRole('rowheader', { name: '4' })).toBeTruthy();
  });

  it('says that rows with errors are skipped and lets the person continue or go back', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({ errors: [issue(4), issue(4, 'REQUIRED'), issue(6)] }),
    });
    await reviewFile(user);
    await stepHeading('Revisa lo que se va a importar');
    expect(
      screen.getByText(/2 filas tienen errores y se saltarán\./),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Confirmar importación' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Elegir otro archivo' }),
    ).toBeTruthy();
  });

  it('shows only the first 50 errors until "Mostrar todos" is pressed', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({ rows_total: 121, errors: manyIssues(120) }),
    });
    await reviewFile(user);
    const table = await screen.findByRole('table', {
      name: /Filas con errores/,
    });
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(table.textContent).toContain('Se muestran 50 de 120.');
    const more = screen.getByRole('button', { name: 'Mostrar todos (120)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    await user.click(more);
    expect(within(table).getAllByRole('row')).toHaveLength(121);
    const less = screen.getByRole('button', {
      name: 'Mostrar solo los primeros 50',
    });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    await user.click(less);
    expect(within(table).getAllByRole('row')).toHaveLength(51);
  });

  it('has no "Mostrar todos" for 50 errors or fewer', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({ errors: manyIssues(50) }),
    });
    await reviewFile(user);
    const table = await screen.findByRole('table', {
      name: /Filas con errores/,
    });
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(screen.queryByRole('button', { name: /Mostrar todos/ })).toBeNull();
  });

  it('lists warnings apart from the errors', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({
        warnings: [
          { row: 3, field: 'debtorName', code: 'FORMULA_PREFIX', message: 'x' },
          { row: 7, field: 'number', code: 'DUPLICATE_IN_FILE', message: 'x' },
        ],
      }),
    });
    await reviewFile(user);
    const table = await screen.findByRole('table', { name: /Avisos/ });
    expect(table.textContent).toContain('Se guarda como texto normal');
    expect(table.textContent).toContain('Se salta');
    expect(
      screen.queryByRole('table', { name: /Filas con errores/ }),
    ).toBeNull();
    expect(screen.getByText(/No impiden importar/)).toBeTruthy();
  });
});

describe('Import: nothing to create', () => {
  it('disables the confirmation and says why when every valid invoice was already imported', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: dryRun({
        debtors_created: 0,
        invoices_created: 0,
        invoices_already_imported: 3,
      }),
    });
    await reviewFile(user);
    const confirm = await screen.findByRole('button', {
      name: 'Confirmar importación',
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    const reason = screen.getByText(
      'Todas las facturas válidas del archivo ya estaban importadas, así que no hay nada nuevo que crear.',
    );
    expect(confirm.getAttribute('aria-describedby')).toBe(reason.id);
    expect(
      screen.getByRole('button', { name: 'Elegir otro archivo' }),
    ).toBeTruthy();
    expect(mock.count(IMPORTS)).toBe(1);
  });

  it('says that no row is valid when every row has errors', async () => {
    const { user } = await openImport({
      [IMPORTS]: dryRun({
        rows_valid: 0,
        debtors_created: 0,
        invoices_created: 0,
        errors: [issue(2), issue(3), issue(4)],
        preview: [],
      }),
    });
    await reviewFile(user);
    expect(await screen.findByText(/Ninguna fila es válida/)).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Confirmar importación' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('Import: files the server refuses', () => {
  it.each<[string, number, Record<string, unknown> | undefined, string]>([
    [
      'CSV_TOO_LARGE',
      413,
      { limit: 1_048_576 },
      'El archivo pesa más de 1 MB.',
    ],
    [
      'CSV_MISSING_COLUMNS',
      422,
      { missing: ['number', 'amount'] },
      'Faltan columnas obligatorias: Factura, Importe.',
    ],
    [
      'CSV_DUPLICATE_COLUMNS',
      422,
      { duplicated: ['amount'] },
      'Hay más de una columna para Importe.',
    ],
    [
      'CSV_MALFORMED',
      422,
      undefined,
      'Hay un valor entre comillas que no se cierra.',
    ],
    ['CSV_EMPTY', 422, undefined, 'El archivo no tiene facturas.'],
    [
      'TOO_MANY_ROWS',
      422,
      { limit: 500 },
      'El archivo tiene más de 500 facturas, que es el máximo por archivo.',
    ],
    [
      'INVOICE_LIMIT_REACHED',
      422,
      { limit: 2000 },
      'Con este archivo se superaría el límite de 2.000 facturas por cuenta.',
    ],
    ['PAYLOAD_TOO_LARGE', 413, undefined, 'El archivo pesa más de 1 MB.'],
    [
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      undefined,
      'No hemos podido leer el archivo.',
    ],
  ])(
    '%s: explains the problem, focuses it and offers another file',
    async (code, status, details, text) => {
      const { user, mock } = await openImport({
        [IMPORTS]: json(status, {
          error: { code, message: 'x', request_id: 'r', details },
        }),
      });
      await reviewFile(user);

      await stepHeading('Este archivo no se puede importar');
      const box = alert();
      expect(box?.textContent).toContain(text);
      expect(box?.getAttribute('role')).toBe('alert');
      await waitFor(() => {
        expect(document.activeElement).toBe(box);
      });
      expect(
        screen.queryByRole('button', { name: 'Confirmar importación' }),
      ).toBeNull();
      expect(
        stepItems().map((step) => step.getAttribute('aria-current')),
      ).toEqual([null, 'step', null]);

      await user.click(
        screen.getByRole('button', { name: 'Elegir otro archivo' }),
      );
      await stepHeading('Elige el archivo');
      expect(fileInput().files).toHaveLength(0);
      expect(alert()?.textContent).toBe('');
      expect(mock.count(IMPORTS)).toBe(1);
    },
  );

  it('does not offer to confirm after a fatal error at confirmation time', async () => {
    const { user } = await openImport({
      [IMPORTS]: [
        dryRun(),
        json(422, {
          error: {
            code: 'INVOICE_LIMIT_REACHED',
            message: 'x',
            request_id: 'r',
            details: { limit: 2000 },
          },
        }),
      ],
    });
    await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Confirmar importación' }),
    );
    await stepHeading('Este archivo no se puede importar');
    expect(alert()?.textContent).toContain('2.000 facturas');
  });
});

describe('Import: hiccups keep the person where they are', () => {
  it('rate limit on the dry run: tells how long to wait, keeps the file and lets them retry', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: [
        apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '90' }),
        dryRun(),
      ],
    });
    await reviewFile(user);
    await waitFor(() => {
      expect(alert()?.textContent).toBe(
        'Demasiados intentos. Espera 2 minutos y vuelve a intentarlo.',
      );
    });
    expect(alert()?.getAttribute('role')).toBe('alert');
    await waitFor(() => {
      expect(document.activeElement).toBe(alert());
    });
    expect(screen.getByText(/Archivo elegido: facturas.csv/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Elige el archivo',
    );

    await user.click(reviewButton());
    await stepHeading('Revisa lo que se va a importar');
    expect(alert()?.textContent).toBe('');
    expect(mock.count(IMPORTS)).toBe(2);
  });

  it.each<[string, Reply, string]>([
    ['network', networkError, 'No hemos podido conectar.'],
    ['500', empty(500), 'Algo ha fallado de nuestro lado.'],
    ['502', empty(502), 'Algo ha fallado de nuestro lado.'],
  ])(
    '%s on the dry run stays on step 1 with the right message',
    async (_name, reply, text) => {
      const { user } = await openImport({ [IMPORTS]: reply });
      await reviewFile(user);
      await waitFor(() => {
        expect(alert()?.textContent).toContain(text);
      });
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
        'Elige el archivo',
      );
      expect(reviewButton().hasAttribute('disabled')).toBe(false);
    },
  );

  it('a failure on confirmation keeps the preview and allows another try with the same file', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: [dryRun(), networkError, real()],
    });
    const sent = await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Confirmar importación' }),
    );
    await waitFor(() => {
      expect(alert()?.textContent).toContain('No hemos podido conectar.');
    });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Revisa lo que se va a importar',
    );
    expect(
      screen
        .getByRole('button', { name: 'Confirmar importación' })
        .hasAttribute('disabled'),
    ).toBe(false);

    await user.click(
      screen.getByRole('button', { name: 'Confirmar importación' }),
    );
    await stepHeading('Importación terminada');
    expect(mock.count(IMPORTS)).toBe(3);
    expect(mock.lastBody(IMPORTS)).toEqual({
      csv_base64: sent.base64,
      dry_run: false,
    });
  });

  it('rate limit on confirmation tells how long to wait', async () => {
    const { user } = await openImport({
      [IMPORTS]: [
        dryRun(),
        apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '30' }),
      ],
    });
    await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Confirmar importación' }),
    );
    await waitFor(() => {
      expect(alert()?.textContent).toContain('Espera 30 segundos');
    });
  });

  it('sends the visitor to the login when the session is gone', async () => {
    const { user, router } = await openImport({ [IMPORTS]: UNAUTHENTICATED });
    await reviewFile(user);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
  });
});

describe('Import: going back, double submits and busy states', () => {
  it('the dry run cannot be submitted twice', async () => {
    const gate = deferred(dryRun());
    const { user, mock } = await openImport({ [IMPORTS]: gate.reply });
    await user.upload(fileInput(), csv().file);
    const button = reviewButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => {
      expect(button.textContent).toBe('Revisando…');
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(mock.count(IMPORTS)).toBe(1);
    gate.release();
    await stepHeading('Revisa lo que se va a importar');
    expect(mock.count(IMPORTS)).toBe(1);
  });

  it('the confirmation shows a busy state, locks the other button and sends once', async () => {
    const gate = deferred(real());
    const { user, mock } = await openImport({
      [IMPORTS]: [dryRun(), gate.reply],
    });
    await reviewFile(user);
    const confirm = await screen.findByRole('button', {
      name: 'Confirmar importación',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(confirm.textContent).toBe('Importando…');
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Elegir otro archivo' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(mock.count(IMPORTS)).toBe(2);
    gate.release();
    await stepHeading('Importación terminada');
    expect(mock.count(IMPORTS)).toBe(2);
  });

  it('"Elegir otro archivo" goes back to an empty step 1', async () => {
    const { user } = await openImport({ [IMPORTS]: dryRun() });
    await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Elegir otro archivo' }),
    );
    const heading = await stepHeading('Elige el archivo');
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(fileInput().files).toHaveLength(0);
    expect(screen.queryByText(/Archivo elegido/)).toBeNull();
    expect(
      stepItems().map((step) => step.getAttribute('aria-current')),
    ).toEqual(['step', null, null]);
  });

  it('"Importar otro archivo" starts over after a finished import and sends the new file', async () => {
    const { user, mock } = await openImport({
      [IMPORTS]: [dryRun(), real(), dryRun()],
    });
    await reviewFile(user);
    await user.click(
      await screen.findByRole('button', { name: 'Confirmar importación' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Importar otro archivo' }),
    );
    await stepHeading('Elige el archivo');
    const second = await reviewFile(
      user,
      'Factura;Cliente;Importe\nF-9;Otro S.L.;1,00\n',
      'otro.csv',
    );
    await stepHeading('Revisa lo que se va a importar');
    expect(mock.lastBody(IMPORTS)).toEqual({
      csv_base64: second.base64,
      dry_run: true,
    });
    expect(screen.getByText('otro.csv')).toBeTruthy();
  });
});
