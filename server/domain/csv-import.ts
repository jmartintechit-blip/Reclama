// Parser for invoice CSV files as Excel in Spanish writes them. It is a pure function: bytes in,
// a result object out, never an exception for bad input. papaparse only handles quotes and line
// breaks; every Spanish rule (encoding, delimiter, headers, amounts, dates) is decided here.
//
// FORMULA PREFIX: a text cell that starts with `=`, `+`, `-` or `@` is kept as plain text and
// reported as a FORMULA_PREFIX warning. Such a value must never be written to a spreadsheet or a
// CSV export without neutralising it first, because Excel would run it as a formula.

import Papa from 'papaparse';
import { diffDays, parseISODate, type ISODate } from './dates.ts';
import { debtorMatchKey, normalizeTaxId } from './debtor.ts';
import { normalizeEmail } from './email.ts';
import { parseMoney, type Cents, type MoneyErrorCode } from './money.ts';

export const MAX_CSV_BYTES = 1_048_576;
export const MAX_CSV_ROWS = 500;
export const MAX_TEXT_LENGTH = 200;

export type CsvDelimiter = ';' | ',' | '\t';
export type CsvEncoding = 'utf-8' | 'windows-1252';

// The canonical column names. Used as `field` in every report entry.
export type ImportField =
  | 'number'
  | 'debtorName'
  | 'taxId'
  | 'email'
  | 'issueDate'
  | 'dueDate'
  | 'amount';

export type ImportErrorCode =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'CONTROL_CHARS'
  | 'INVALID_EMAIL'
  | 'INVALID_DATE'
  | 'DUE_BEFORE_ISSUE'
  | 'TOO_MANY_COLUMNS'
  // The reason `parseMoney` gave, for example AMOUNT_AMBIGUOUS_SEPARATOR.
  | `AMOUNT_${Exclude<MoneyErrorCode, 'EMPTY'>}`;

export type ImportWarningCode = 'FORMULA_PREFIX' | 'DUPLICATE_IN_FILE';

// `row` is the 1-based line in the file (the header is line 1 unless blank lines come first).
// `field` is null when the problem is about the whole row.
export interface RowIssue<Code extends string> {
  row: number;
  field: ImportField | null;
  code: Code;
  message: string;
}
export type ImportError = RowIssue<ImportErrorCode>;
export type ImportWarning = RowIssue<ImportWarningCode>;

export interface ParsedInvoiceRow {
  row: number;
  number: string;
  debtorName: string;
  taxId: string | null;
  email: string | null;
  issueDate: ISODate;
  // Null when the file has no due date: the interest engine estimates it later.
  dueDate: ISODate | null;
  amount: Cents;
}

export type FatalCsvCode =
  | 'CSV_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'CSV_EMPTY'
  | 'CSV_MALFORMED'
  | 'CSV_MISSING_COLUMNS'
  | 'CSV_DUPLICATE_COLUMNS';

export interface FatalCsvDetails {
  // CSV_TOO_LARGE (bytes) and TOO_MANY_ROWS (data rows).
  limit?: number;
  // CSV_MISSING_COLUMNS.
  missing?: ImportField[];
  // CSV_DUPLICATE_COLUMNS: fields that more than one column maps to.
  duplicated?: ImportField[];
}

export type ParseInvoiceCsvResult =
  | {
      ok: true;
      delimiter: CsvDelimiter;
      encoding: CsvEncoding;
      // Valid, de-duplicated rows. A row with any error is not here.
      rows: ParsedInvoiceRow[];
      errors: ImportError[];
      warnings: ImportWarning[];
      // Data rows in the file (blank lines not counted), valid or not.
      totalRows: number;
    }
  | {
      ok: false;
      code: FatalCsvCode;
      message: string;
      details?: FatalCsvDetails;
    };

const fatal = (
  code: FatalCsvCode,
  message: string,
  details?: FatalCsvDetails,
): ParseInvoiceCsvResult =>
  details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details };

// Header aliases, already without accents. They go through `normalizeHeader` as well, so the
// spelling here only has to be readable.
const HEADER_ALIASES: Record<ImportField, string[]> = {
  number: [
    'factura',
    'numero',
    'nº',
    'n factura',
    'num',
    'num factura',
    'numero factura',
    'n de factura',
    'nro',
    'invoice',
    'number',
    'invoice number',
  ],
  debtorName: [
    'cliente',
    'deudor',
    'nombre',
    'razon social',
    'nombre cliente',
    'nombre deudor',
    'customer',
    'debtor',
    'name',
    'customer name',
  ],
  taxId: ['nif', 'cif', 'nif/cif', 'cif/nif', 'nif cif', 'nif-cif', 'tax id'],
  email: ['email', 'correo', 'e-mail', 'correo electronico', 'mail'],
  issueDate: [
    'fecha',
    'fecha emision',
    'fecha de emision',
    'fecha factura',
    'emision',
    'issue date',
    'invoice date',
    'date',
  ],
  dueDate: [
    'vencimiento',
    'fecha vencimiento',
    'fecha de vencimiento',
    'vto',
    'fecha vto',
    'due date',
    'due',
  ],
  amount: ['importe', 'total', 'importe total', 'total factura', 'amount'],
};

const REQUIRED_FIELDS: ImportField[] = [
  'number',
  'debtorName',
  'issueDate',
  'amount',
];

// Trim, lower case, no accents, no ordinal signs (º ° are not accents, NFD keeps them), and runs
// of spaces, dots and underscores become one space: " N.º_Factura " is "n factura".
function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[º°]/g, '')
    .replace(/[\s._]+/g, ' ')
    .trim();
}

const FIELD_BY_HEADER = new Map<string, ImportField>(
  (Object.entries(HEADER_ALIASES) as [ImportField, string[]][]).flatMap(
    ([field, aliases]) =>
      aliases.map((alias): [string, ImportField] => [
        normalizeHeader(alias),
        field,
      ]),
  ),
);

function decode(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(body),
      encoding: 'utf-8',
    };
  } catch {
    // Excel in Spanish saves "CSV (delimitado por comas)" as windows-1252.
    return {
      text: new TextDecoder('windows-1252').decode(body),
      encoding: 'windows-1252',
    };
  }
}

const DELIMITER_CANDIDATES: CsvDelimiter[] = [';', ',', '\t'];

// Counts the candidates outside quotes on the header line (the first line with content). Like
// papaparse, a quote only opens a quoted field at the start of a field. The most frequent wins and
// a tie (or no candidate at all) goes to ";".
function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ';': 0, ',': 0, '\t': 0 };
  let inQuotes = false;
  let atFieldStart = true;
  let seenContent = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (seenContent) break;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
    } else if (DELIMITER_CANDIDATES.includes(ch as CsvDelimiter)) {
      counts[ch as CsvDelimiter]++;
      atFieldStart = true;
      seenContent = true;
      continue;
    }
    atFieldStart = false;
    seenContent ||= ch !== ' ';
  }

  return DELIMITER_CANDIDATES.reduce((best, candidate) =>
    counts[candidate] > counts[best] ? candidate : best,
  );
}

const LINE_BREAK = /\r\n|\r|\n/g;

interface CsvRecord {
  line: number;
  cells: string[];
}

// Rows with their physical line in the file. A quoted cell can hold line breaks, so a record can
// span several lines; blank records (empty lines, or only delimiters) are dropped after counting.
function toRecords(data: string[][]): CsvRecord[] {
  const records: CsvRecord[] = [];
  let line = 1;
  for (const cells of data) {
    if (cells.some((cell) => cell.trim() !== '')) records.push({ line, cells });
    line += 1;
    for (const cell of cells) line += cell.match(LINE_BREAK)?.length ?? 0;
  }
  return records;
}

type TextField = 'number' | 'debtorName' | 'taxId' | 'email';

const FORMULA_PREFIX = /^[=+\-@]/;
// Control characters and invisible format characters (zero width, bidirectional marks).
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;

const DMY_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const YMD_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

// A real calendar date with a 4-digit year, or null.
function parseDate(text: string): ISODate | null {
  const dmy = DMY_DATE.exec(text);
  const ymd = dmy === null ? YMD_DATE.exec(text) : null;
  const [day, month, year] = dmy
    ? [dmy[1], dmy[3], dmy[4]]
    : ymd
      ? [ymd[3], ymd[2], ymd[1]]
      : [undefined, undefined, undefined];
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return parseISODate(
    `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
  );
}

const AMOUNT_MESSAGES: Record<MoneyErrorCode, string> = {
  EMPTY: 'The amount is required',
  NEGATIVE: 'The amount cannot be negative',
  ZERO: 'The amount must be greater than zero',
  EXPONENT: 'The amount cannot use scientific notation',
  INVALID_FORMAT: 'The amount is not a valid number',
  AMBIGUOUS_SEPARATOR:
    'The amount is ambiguous: three digits after a single comma could be thousands or decimals; write two decimals, for example 1.234,00',
  TOO_MANY_DECIMALS: 'The amount has more than two decimals',
  TOO_LARGE: 'The amount is too large',
};

const FIELD_LABELS: Record<ImportField, string> = {
  number: 'The invoice number',
  debtorName: 'The debtor name',
  taxId: 'The tax id',
  email: 'The email',
  issueDate: 'The issue date',
  dueDate: 'The due date',
  amount: 'The amount',
};

// Validates one data record and appends what it finds to `errors` and `warnings`. Returns the
// parsed row, or null when the record has at least one error.
function parseRecord(
  { line, cells }: CsvRecord,
  columns: Partial<Record<ImportField, number>>,
  columnCount: number,
  errors: ImportError[],
  warnings: ImportWarning[],
): ParsedInvoiceRow | null {
  const errorsBefore = errors.length;
  const addError = (
    field: ImportField | null,
    code: ImportErrorCode,
    message: string,
  ) => errors.push({ row: line, field, code, message });

  const rawCell = (field: ImportField): string => {
    const index = columns[field];
    return (index === undefined ? '' : (cells[index] ?? '')).trim();
  };

  if (cells.slice(columnCount).some((cell) => cell.trim() !== '')) {
    addError(
      null,
      'TOO_MANY_COLUMNS',
      'The row has more values than the header has columns; a delimiter inside a value needs quotes',
    );
  }

  const readText = (field: TextField, required: boolean): string | null => {
    const value = rawCell(field);
    if (value === '') {
      if (required)
        addError(field, 'REQUIRED', `${FIELD_LABELS[field]} is required`);
      return null;
    }
    if (FORMULA_PREFIX.test(value)) {
      warnings.push({
        row: line,
        field,
        code: 'FORMULA_PREFIX',
        message: `${FIELD_LABELS[field]} starts with = + - or @; it is kept as plain text`,
      });
    }
    if (value.length > MAX_TEXT_LENGTH) {
      addError(
        field,
        'TOO_LONG',
        `${FIELD_LABELS[field]} is longer than ${String(MAX_TEXT_LENGTH)} characters`,
      );
      return null;
    }
    if (FORBIDDEN_CHARS.test(value)) {
      addError(
        field,
        'CONTROL_CHARS',
        `${FIELD_LABELS[field]} contains control or invisible characters`,
      );
      return null;
    }
    return value;
  };

  const readDate = (field: 'issueDate' | 'dueDate'): ISODate | null => {
    const value = rawCell(field);
    if (value === '') {
      if (field === 'issueDate') {
        addError(field, 'REQUIRED', `${FIELD_LABELS[field]} is required`);
      }
      return null;
    }
    const date = parseDate(value);
    if (date === null) {
      addError(
        field,
        'INVALID_DATE',
        `${FIELD_LABELS[field]} is not a real date; use dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy or yyyy-mm-dd`,
      );
    }
    return date;
  };

  const number = readText('number', true);
  const debtorName = readText('debtorName', true);
  const rawTaxId = readText('taxId', false);
  const rawEmail = readText('email', false);
  const email = rawEmail === null ? null : normalizeEmail(rawEmail);
  if (rawEmail !== null && email === null) {
    addError('email', 'INVALID_EMAIL', 'The email is not valid');
  }
  const issueDate = readDate('issueDate');
  const dueDate = readDate('dueDate');
  if (
    issueDate !== null &&
    dueDate !== null &&
    diffDays(dueDate, issueDate) < 0
  ) {
    addError(
      'dueDate',
      'DUE_BEFORE_ISSUE',
      'The due date is before the issue date',
    );
  }

  let amount: Cents | null = null;
  const rawAmount = rawCell('amount');
  if (rawAmount === '') {
    addError('amount', 'REQUIRED', 'The amount is required');
  } else {
    const money = parseMoney(rawAmount);
    if (money.ok) amount = money.cents;
    else {
      addError(
        'amount',
        money.code === 'EMPTY' ? 'REQUIRED' : `AMOUNT_${money.code}`,
        AMOUNT_MESSAGES[money.code],
      );
    }
  }

  if (
    errors.length > errorsBefore ||
    number === null ||
    debtorName === null ||
    issueDate === null ||
    amount === null
  ) {
    return null;
  }
  const taxId = rawTaxId === null ? '' : normalizeTaxId(rawTaxId);
  return {
    row: line,
    number,
    debtorName,
    taxId: taxId === '' ? null : taxId,
    email,
    issueDate,
    dueDate,
    amount,
  };
}

export function parseInvoiceCsv(bytes: Uint8Array): ParseInvoiceCsvResult {
  if (bytes.length > MAX_CSV_BYTES) {
    return fatal('CSV_TOO_LARGE', 'The file is larger than 1 MB', {
      limit: MAX_CSV_BYTES,
    });
  }

  const { text, encoding } = decode(bytes);
  const delimiter = detectDelimiter(text);
  const parsed = Papa.parse<string[]>(text, { delimiter });
  if (parsed.errors.some((error) => error.type === 'Quotes')) {
    return fatal('CSV_MALFORMED', 'A quoted value is not closed correctly');
  }

  const [header, ...dataRecords] = toRecords(parsed.data);
  if (header === undefined || dataRecords.length === 0) {
    return fatal('CSV_EMPTY', 'The file has no invoice rows');
  }

  const columns: Partial<Record<ImportField, number>> = {};
  const duplicated = new Set<ImportField>();
  header.cells.forEach((cell, index) => {
    const field = FIELD_BY_HEADER.get(normalizeHeader(cell));
    if (field === undefined) return;
    if (columns[field] === undefined) columns[field] = index;
    else duplicated.add(field);
  });
  const missing = REQUIRED_FIELDS.filter(
    (field) => columns[field] === undefined,
  );
  if (missing.length > 0) {
    return fatal(
      'CSV_MISSING_COLUMNS',
      `Missing required columns: ${missing.join(', ')}`,
      { missing },
    );
  }
  if (duplicated.size > 0) {
    // Taking the first one silently could import the wrong amount ("importe" and "total").
    const fields = [...duplicated];
    return fatal(
      'CSV_DUPLICATE_COLUMNS',
      `More than one column for: ${fields.join(', ')}`,
      { duplicated: fields },
    );
  }

  if (dataRecords.length > MAX_CSV_ROWS) {
    return fatal('TOO_MANY_ROWS', 'The file has more than 500 invoice rows', {
      limit: MAX_CSV_ROWS,
    });
  }

  const rows: ParsedInvoiceRow[] = [];
  const errors: ImportError[] = [];
  const warnings: ImportWarning[] = [];
  const firstRowOf = new Map<string, number>();

  for (const record of dataRecords) {
    const row = parseRecord(
      record,
      columns,
      header.cells.length,
      errors,
      warnings,
    );
    if (row === null) continue;

    const identity = JSON.stringify([
      debtorMatchKey(row.debtorName, row.taxId),
      row.number,
    ]);
    const firstRow = firstRowOf.get(identity);
    if (firstRow === undefined) {
      firstRowOf.set(identity, row.row);
      rows.push(row);
    } else {
      warnings.push({
        row: row.row,
        field: 'number',
        code: 'DUPLICATE_IN_FILE',
        message: `Same debtor and invoice number as row ${String(firstRow)}; skipped`,
      });
    }
  }

  return {
    ok: true,
    delimiter,
    encoding,
    rows,
    errors,
    warnings,
    totalRows: dataRecords.length,
  };
}
