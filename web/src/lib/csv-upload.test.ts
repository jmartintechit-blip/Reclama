import { describe, expect, it } from 'vitest';
import type { Failure } from './api.ts';
import {
  describeImportError,
  describeRowIssue,
  fieldName,
  FILE_TOO_LARGE_MESSAGE,
  fileProblem,
  fileToBase64,
  formatFileSize,
  isFileProblem,
  MAX_CSV_BYTES,
  UNREADABLE_MESSAGE,
} from './csv-upload.ts';
import { NETWORK_MESSAGE, SERVER_MESSAGE } from './messages.ts';

const blobOf = (bytes: number[] | Uint8Array) =>
  new Blob([new Uint8Array(bytes)]);
// A reference that shares nothing with the chunked code: one byte per character, encoded whole.
const expected = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decode = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

describe('fileToBase64', () => {
  it('encodes an empty file as an empty string', async () => {
    expect(await fileToBase64(blobOf([]))).toBe('');
  });

  it('pads one and two bytes like standard base64', async () => {
    expect(await fileToBase64(blobOf([0x41]))).toBe('QQ==');
    expect(await fileToBase64(blobOf([0x41, 0x42]))).toBe('QUI=');
  });

  it('encodes exactly three bytes without padding', async () => {
    expect(await fileToBase64(blobOf([0x41, 0x42, 0x43]))).toBe('QUJD');
  });

  it.each([24_575, 24_576, 24_577, 49_152, 49_153])(
    'joins the chunks of a %i byte file into valid base64',
    async (size) => {
      // The sizes sit on both sides of the chunk boundary (24 576 bytes).
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 256);
      expect(await fileToBase64(blobOf(bytes))).toBe(expected(bytes));
    },
  );

  it('encodes a 900 kB file without overflowing the stack', async () => {
    const bytes = Uint8Array.from(
      { length: 900 * 1024 },
      (_, i) => (i * 31 + 5) % 256,
    );
    const encoded = await fileToBase64(blobOf(bytes));
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(encoded).toBe(expected(bytes));
  });

  it('keeps the bytes above 0x7F: windows-1252 ñ and é stay as they are', async () => {
    // "Muñoz;José" saved by Excel in Spanish: ñ is 0xF1 and é is 0xE9, not UTF-8.
    const bytes = Uint8Array.from([
      0x4d, 0x75, 0xf1, 0x6f, 0x7a, 0x3b, 0x4a, 0x6f, 0x73, 0xe9,
    ]);
    const encoded = await fileToBase64(blobOf(bytes));
    expect(encoded).toBe(expected(bytes));
    expect([...decode(encoded)]).toEqual([...bytes]);
  });
});

describe('formatFileSize', () => {
  it.each([
    [0, '0 bytes'],
    [1018, '1018 bytes'],
    [1024, '1 kB'],
    [1536, '1,5 kB'],
    [MAX_CSV_BYTES - 1, '1024 kB'],
    [MAX_CSV_BYTES, '1 MB'],
    [2_621_440, '2,5 MB'],
  ])('%i bytes -> %s', (bytes, text) => {
    expect(formatFileSize(bytes)).toBe(text);
  });
});

describe('fileProblem', () => {
  it('lets a normal CSV through, whatever the case of the extension', () => {
    expect(fileProblem({ name: 'facturas.csv', size: 1018 })).toBeNull();
    expect(
      fileProblem({ name: 'FACTURAS.CSV', size: MAX_CSV_BYTES }),
    ).toBeNull();
    expect(fileProblem({ name: 'sin-extension', size: 10 })).toBeNull();
  });

  it('refuses an empty file, a file over 1 MB and an Excel workbook', () => {
    expect(fileProblem({ name: 'a.csv', size: 0 })).toContain('vacío');
    expect(fileProblem({ name: 'a.csv', size: MAX_CSV_BYTES + 1 })).toBe(
      FILE_TOO_LARGE_MESSAGE,
    );
    for (const name of ['a.xlsx', 'a.XLS', 'a.xlsm', 'a.ods']) {
      expect(fileProblem({ name, size: 10 })).toContain('Guardar como');
    }
  });
});

const failure = (
  extra: Partial<Failure> & Pick<Failure, 'kind' | 'status'>,
): Failure => ({
  ok: false,
  ...extra,
});
const fatal = (code: string, extras: Partial<Failure> = {}) =>
  failure({ kind: 'validation', status: 422, code, ...extras });

describe('describeImportError', () => {
  it('uses one message for a file that is too large, wherever it is detected', () => {
    const tooLarge = failure({
      kind: 'server',
      status: 413,
      code: 'CSV_TOO_LARGE',
    });
    expect(describeImportError(tooLarge)).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(
      describeImportError(
        failure({ kind: 'server', status: 413, code: 'PAYLOAD_TOO_LARGE' }),
      ),
    ).toBe(FILE_TOO_LARGE_MESSAGE);
    // An edge or proxy answering 413 with an HTML body carries no code.
    expect(describeImportError(failure({ kind: 'server', status: 413 }))).toBe(
      FILE_TOO_LARGE_MESSAGE,
    );
  });

  it('lists the missing columns by their Spanish names', () => {
    const text = describeImportError(
      fatal('CSV_MISSING_COLUMNS', {
        extra: { missing: ['number', 'debtorName', 'issueDate', 'amount'] },
      }),
    );
    expect(text).toContain('Factura, Cliente, Fecha de emisión, Importe');
    expect(describeImportError(fatal('CSV_MISSING_COLUMNS'))).toBe(
      'Faltan columnas obligatorias. Corrige los nombres de la primera fila del archivo; al volver a elegirlo verás la lista de nombres que se entienden.',
    );
  });

  it('names the duplicated columns', () => {
    expect(
      describeImportError(
        fatal('CSV_DUPLICATE_COLUMNS', { extra: { duplicated: ['amount'] } }),
      ),
    ).toContain('más de una columna para Importe');
    expect(describeImportError(fatal('CSV_DUPLICATE_COLUMNS'))).toContain(
      'el mismo dato',
    );
  });

  it('says the limits with their figures, from the answer or from the defaults', () => {
    expect(
      describeImportError(fatal('TOO_MANY_ROWS', { extra: { limit: 500 } })),
    ).toContain('más de 500 facturas');
    expect(describeImportError(fatal('TOO_MANY_ROWS'))).toContain('500');
    expect(
      describeImportError(
        fatal('INVOICE_LIMIT_REACHED', { extra: { limit: 2000 } }),
      ),
    ).toContain('límite de 2.000 facturas por cuenta');
    expect(describeImportError(fatal('INVOICE_LIMIT_REACHED'))).toContain(
      '2.000',
    );
    // A figure that is not a number is not trusted.
    expect(
      describeImportError(fatal('TOO_MANY_ROWS', { extra: { limit: '9' } })),
    ).toContain('500');
  });

  it.each([
    ['CSV_EMPTY', 'no tiene facturas'],
    ['CSV_MALFORMED', 'entre comillas'],
  ])('explains %s', (code, part) => {
    expect(describeImportError(fatal(code))).toContain(part);
  });

  it('turns every other answer into the generic texts of the app', () => {
    expect(describeImportError(failure({ kind: 'network', status: 0 }))).toBe(
      NETWORK_MESSAGE,
    );
    expect(describeImportError(failure({ kind: 'server', status: 500 }))).toBe(
      SERVER_MESSAGE,
    );
    expect(
      describeImportError(failure({ kind: 'unavailable', status: 502 })),
    ).toBe(SERVER_MESSAGE);
    expect(
      describeImportError(
        failure({ kind: 'rate_limited', status: 429, retryAfter: 90 }),
      ),
    ).toBe('Demasiados intentos. Espera 2 minutos y vuelve a intentarlo.');
    expect(
      describeImportError(failure({ kind: 'rate_limited', status: 429 })),
    ).toContain('Espera unos minutos');
    expect(
      describeImportError(failure({ kind: 'unauthenticated', status: 401 })),
    ).toContain('sesión ha caducado');
  });

  it('asks to choose the file again for a 415 or an unknown 4xx about the body', () => {
    expect(describeImportError(failure({ kind: 'server', status: 415 }))).toBe(
      UNREADABLE_MESSAGE,
    );
    expect(
      describeImportError(
        failure({ kind: 'validation', status: 400, code: 'INVALID_BODY' }),
      ),
    ).toBe(UNREADABLE_MESSAGE);
  });

  it('never shows raw English: every message is Spanish', () => {
    const all = [
      fatal('CSV_TOO_LARGE'),
      fatal('CSV_EMPTY'),
      fatal('CSV_MISSING_COLUMNS'),
      fatal('CSV_DUPLICATE_COLUMNS'),
      fatal('CSV_MALFORMED'),
      fatal('TOO_MANY_ROWS'),
      fatal('INVOICE_LIMIT_REACHED'),
      fatal('SOMETHING_NEW'),
    ];
    for (const item of all) {
      expect(describeImportError(item)).not.toMatch(/\b(the|file|missing)\b/i);
    }
  });
});

describe('isFileProblem', () => {
  it('tells a bad file from a hiccup', () => {
    expect(isFileProblem(fatal('CSV_MALFORMED'))).toBe(true);
    expect(isFileProblem(failure({ kind: 'server', status: 413 }))).toBe(true);
    expect(isFileProblem(failure({ kind: 'server', status: 415 }))).toBe(true);
    expect(
      isFileProblem(failure({ kind: 'validation', status: 400, code: 'X' })),
    ).toBe(true);
    for (const hiccup of [
      failure({ kind: 'network', status: 0 }),
      failure({ kind: 'rate_limited', status: 429 }),
      failure({ kind: 'server', status: 500 }),
      failure({ kind: 'unavailable', status: 503 }),
      failure({ kind: 'unauthenticated', status: 401 }),
    ]) {
      expect(isFileProblem(hiccup)).toBe(false);
    }
  });
});

describe('describeRowIssue', () => {
  // Every code the server's parser can report, with a part of its Spanish text.
  const CODES: [string, string][] = [
    ['REQUIRED', 'obligatorio'],
    ['TOO_LONG', '200 caracteres'],
    ['CONTROL_CHARS', 'invisibles'],
    ['INVALID_EMAIL', 'email no es válido'],
    ['INVALID_DATE', 'dd/mm/aaaa'],
    ['DUE_BEFORE_ISSUE', 'anterior'],
    ['TOO_MANY_COLUMNS', 'comillas'],
    ['AMOUNT_NEGATIVE', 'negativo'],
    ['AMOUNT_ZERO', 'mayor que cero'],
    ['AMOUNT_EXPONENT', 'científica'],
    ['AMOUNT_INVALID_FORMAT', 'no es un número válido'],
    ['AMOUNT_AMBIGUOUS_SEPARATOR', 'ambiguo'],
    ['AMOUNT_TOO_MANY_DECIMALS', 'dos decimales'],
    ['AMOUNT_TOO_LARGE', 'demasiado grande'],
    ['FORMULA_PREFIX', 'texto normal'],
    ['DUPLICATE_IN_FILE', 'Se salta'],
  ];

  it.each(CODES)('%s has a Spanish text', (code, part) => {
    const text = describeRowIssue({
      row: 2,
      field: 'amount',
      code,
      message: 'English message from the server',
    });
    expect(text).toContain(part);
    expect(text).not.toContain('English');
  });

  it('falls back to the server message for a code it does not know', () => {
    expect(
      describeRowIssue({
        row: 2,
        field: null,
        code: 'NEW_RULE',
        message: 'Something new',
      }),
    ).toBe('Something new');
  });
});

describe('fieldName', () => {
  it('names the columns as the file calls them and null as the whole row', () => {
    expect(fieldName('debtorName')).toBe('Cliente');
    expect(fieldName('issueDate')).toBe('Fecha de emisión');
    expect(fieldName('taxId')).toBe('NIF/CIF');
    expect(fieldName(null)).toBe('Toda la fila');
    expect(fieldName('somethingNew')).toBe('somethingNew');
  });
});
