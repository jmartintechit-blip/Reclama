// What the CSV import screen needs besides the API call itself: turning the chosen file into the
// base64 the endpoint takes, the checks that can be made before sending anything, and the Spanish
// texts for every way the import can fail. The browser never reads the CSV: the server is the
// only parser (encoding, quotes, separators), so a text here may only depend on a code or a count
// the server sent.
import type { Failure } from './api.ts';
import type { ImportRowIssue } from './api-types.ts';
import { formatCount } from './format.ts';
import { failureMessage } from './messages.ts';

// The server's limits, shown to the person and used to refuse an oversized file before uploading.
export const MAX_CSV_BYTES = 1_048_576;
export const MAX_CSV_ROWS = 500;
// The server's per-account cap, used only when its answer does not carry the figure.
const DEFAULT_INVOICE_LIMIT = 2000;

export const FILE_TOO_LARGE_MESSAGE =
  'El archivo pesa más de 1 MB. Quita las columnas que no necesites o divídelo en varios archivos.';
const EXCEL_MESSAGE =
  'Esto parece un archivo de Excel. En Excel elige Archivo > Guardar como > «CSV (delimitado por comas)» y sube ese archivo.';
export const UNREADABLE_MESSAGE =
  'No hemos podido leer el archivo. Vuelve a elegirlo; si sigue fallando, guárdalo de nuevo como CSV.';

// 3 bytes become exactly 4 base64 characters, so a chunk whose length is a multiple of 3 encodes
// without padding and the encoded chunks can simply be joined. 24 576 bytes keep each
// String.fromCharCode call far below the argument limit.
const CHUNK_BYTES = 3 * 8192;

export async function fileToBase64(
  file: Pick<Blob, 'arrayBuffer'>,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoded = '';
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    encoded += btoa(
      String.fromCharCode(...bytes.subarray(start, start + CHUNK_BYTES)),
    );
  }
  return encoded;
}

// 1018 -> "1018 bytes"; 1_048_576 -> "1 MB". Binary units, one decimal at most.
export function formatFileSize(bytes: number): string {
  const decimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${decimal.format(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${decimal.format(bytes / 1024)} kB`;
  return `${decimal.format(bytes / (1024 * 1024))} MB`;
}

// What can be said about a file before it is sent, or null when it may go. The extension test only
// catches Excel files, which would otherwise come back from the server as "columns missing".
export function fileProblem(file: {
  name: string;
  size: number;
}): string | null {
  if (file.size === 0) return 'El archivo está vacío. Elige otro.';
  if (file.size > MAX_CSV_BYTES) return FILE_TOO_LARGE_MESSAGE;
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(file.name)) return EXCEL_MESSAGE;
  return null;
}

const FIELD_NAMES: Record<string, string> = {
  number: 'Factura',
  debtorName: 'Cliente',
  taxId: 'NIF/CIF',
  email: 'Email',
  issueDate: 'Fecha de emisión',
  dueDate: 'Vencimiento',
  amount: 'Importe',
};

// The column named as the person sees it in the file; null is "the row as a whole".
export function fieldName(field: string | null): string {
  if (field === null) return 'Toda la fila';
  return FIELD_NAMES[field] ?? field;
}

const ROW_PROBLEMS: Record<string, string> = {
  REQUIRED: 'Falta este dato y es obligatorio.',
  TOO_LONG: 'Es demasiado largo (máximo 200 caracteres).',
  CONTROL_CHARS:
    'Tiene caracteres invisibles o de control. Bórralo y escríbelo de nuevo.',
  INVALID_EMAIL: 'El email no es válido. Ejemplo: nombre@empresa.es.',
  INVALID_DATE:
    'La fecha no existe o no se entiende. Usa dd/mm/aaaa o aaaa-mm-dd.',
  DUE_BEFORE_ISSUE: 'El vencimiento es anterior a la fecha de emisión.',
  TOO_MANY_COLUMNS:
    'La fila tiene más valores que columnas. Si un valor lleva ; o , dentro, ponlo entre comillas.',
  AMOUNT_NEGATIVE: 'El importe no puede ser negativo.',
  AMOUNT_ZERO: 'El importe debe ser mayor que cero.',
  AMOUNT_EXPONENT:
    'El importe no admite notación científica. Escríbelo con cifras, por ejemplo 1.234,56.',
  AMOUNT_INVALID_FORMAT:
    'El importe no es un número válido. Ejemplo: 1.234,56.',
  AMOUNT_AMBIGUOUS_SEPARATOR:
    'El importe es ambiguo. Escríbelo con dos decimales, por ejemplo 1.234,00.',
  AMOUNT_TOO_MANY_DECIMALS: 'El importe tiene más de dos decimales.',
  AMOUNT_TOO_LARGE: 'El importe es demasiado grande.',
  FORMULA_PREFIX:
    'Empieza por = + - o @. Se guarda como texto normal, no como fórmula.',
  DUPLICATE_IN_FILE:
    'Repite el cliente y el número de otra fila del archivo. Se salta.',
};

// A row error or warning in Spanish. A code the app does not know yet falls back to the server's
// own (English) message, which is better than saying nothing.
export function describeRowIssue(issue: ImportRowIssue): string {
  return ROW_PROBLEMS[issue.code] ?? issue.message;
}

function fieldList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(fieldName)
    .join(', ');
}

function limitOf(failure: Failure, fallback: number): number {
  const limit = failure.extra?.limit;
  return typeof limit === 'number' && Number.isSafeInteger(limit)
    ? limit
    : fallback;
}

// Does the answer say something is wrong with the file itself (so choosing another one is the
// way out), as opposed to a hiccup where sending the same file again may well work?
export function isFileProblem(failure: Failure): boolean {
  return (
    failure.status === 413 ||
    failure.status === 415 ||
    failure.kind === 'validation'
  );
}

// A failed import call in Spanish: what happened and what to do about it.
export function describeImportError(failure: Failure): string {
  switch (failure.code) {
    case 'CSV_TOO_LARGE':
    case 'PAYLOAD_TOO_LARGE':
      return FILE_TOO_LARGE_MESSAGE;
    case 'CSV_EMPTY':
      return 'El archivo no tiene facturas. Debe llevar una primera fila con los nombres de las columnas y, debajo, una factura por fila.';
    case 'CSV_MISSING_COLUMNS': {
      const missing = fieldList(failure.extra?.missing);
      return `Faltan columnas obligatorias${missing ? `: ${missing}` : ''}. Corrige los nombres de la primera fila del archivo; al volver a elegirlo verás la lista de nombres que se entienden.`;
    }
    case 'CSV_DUPLICATE_COLUMNS': {
      const duplicated = fieldList(failure.extra?.duplicated);
      return `Hay más de una columna para ${duplicated || 'el mismo dato'}. Deja una sola columna para cada dato y vuelve a subir el archivo.`;
    }
    case 'CSV_MALFORMED':
      return 'Hay un valor entre comillas que no se cierra. Revisa las comillas (") del archivo y vuelve a subirlo.';
    case 'TOO_MANY_ROWS':
      return `El archivo tiene más de ${formatCount(limitOf(failure, MAX_CSV_ROWS))} facturas, que es el máximo por archivo. Divídelo en varios y súbelos uno a uno.`;
    case 'INVOICE_LIMIT_REACHED':
      return `Con este archivo se superaría el límite de ${formatCount(limitOf(failure, DEFAULT_INVOICE_LIMIT))} facturas por cuenta. Sube un archivo con menos facturas.`;
    default:
      break;
  }
  if (failure.status === 413) return FILE_TOO_LARGE_MESSAGE;
  if (failure.status === 415 || failure.kind === 'validation') {
    return UNREADABLE_MESSAGE;
  }
  return failureMessage(failure);
}
