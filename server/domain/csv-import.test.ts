import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  MAX_TEXT_LENGTH,
  parseInvoiceCsv,
  type RowIssue,
} from './csv-import.ts';
import { debtorMatchKey } from './debtor.ts';

const HEADER = 'Factura;Cliente;Fecha;Importe';
const encoder = new TextEncoder();

function ok(input: string | Uint8Array) {
  const result = parseInvoiceCsv(
    typeof input === 'string' ? encoder.encode(input) : input,
  );
  if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);
  return result;
}

function fatal(input: string | Uint8Array) {
  const result = parseInvoiceCsv(
    typeof input === 'string' ? encoder.encode(input) : input,
  );
  if (result.ok) throw new Error('Expected a fatal result');
  return result;
}

// A file with the standard header and the given lines.
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';
const line = (
  number = 'F1',
  name = 'Acme S.L.',
  date = '01/03/2026',
  amount = '100,00',
) => [number, name, date, amount].join(';');

// [row, field, code] for each entry: enough to check which problem is where.
const brief = (issues: RowIssue<string>[]) =>
  issues.map((i) => [i.row, i.field, i.code]);

// What Excel in Spanish writes: windows-1252, where the euro sign is the single byte 0x80.
function windows1252(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => (ch === '€' ? 0x80 : ch.charCodeAt(0)));
}

describe('parseInvoiceCsv: a valid file', () => {
  it('returns typed rows with their file line, cents and ISO dates', () => {
    const result = ok(
      'Factura;Cliente;NIF;Email;Fecha;Vencimiento;Importe\n' +
        'F-1;  Acme S.L. ;b-12 345 678;pagos@example.com;05/01/2026;04/02/2026;1.234,56\n' +
        'F-2;Beta;;;2026-03-01;;7\n',
    );

    expect(result).toEqual({
      ok: true,
      delimiter: ';',
      encoding: 'utf-8',
      totalRows: 2,
      errors: [],
      warnings: [],
      rows: [
        {
          row: 2,
          number: 'F-1',
          debtorName: 'Acme S.L.',
          taxId: 'B12345678',
          email: 'pagos@example.com',
          issueDate: '2026-01-05',
          dueDate: '2026-02-04',
          amount: 123456,
        },
        {
          row: 3,
          number: 'F-2',
          debtorName: 'Beta',
          taxId: null,
          email: null,
          issueDate: '2026-03-01',
          dueDate: null,
          amount: 700,
        },
      ],
    });
  });

  it('survives a JSON round trip unchanged', () => {
    const result = ok(file(line()));

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe('parseInvoiceCsv: encoding', () => {
  it('strips a UTF-8 BOM so the first header is recognised', () => {
    const bytes = encoder.encode('﻿' + file(line()));

    expect(bytes.subarray(0, 3)).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf));
    const result = ok(bytes);
    expect(result.rows).toHaveLength(1);
    expect(result.encoding).toBe('utf-8');
  });

  it('reads accents and the euro sign in UTF-8', () => {
    const result = ok(
      file(line('F1', 'Muñoz Peña S.L.', '01/03/2026', '12,50 €')),
    );

    expect(result.encoding).toBe('utf-8');
    expect(result.rows[0]).toMatchObject({
      debtorName: 'Muñoz Peña S.L.',
      amount: 1250,
    });
  });

  it('falls back to windows-1252 bytes: é (0xE9), ñ (0xF1) and € (0x80)', () => {
    const bytes = windows1252(
      file(line('F1', 'José Muñoz S.L.', '01/03/2026', '12,50 €')),
    );

    expect(bytes).toContain(0xe9);
    expect(bytes).toContain(0xf1);
    expect(bytes).toContain(0x80);
    const result = ok(bytes);
    expect(result.encoding).toBe('windows-1252');
    expect(result.rows[0]).toMatchObject({
      debtorName: 'José Muñoz S.L.',
      amount: 1250,
    });
  });

  it('strips the BOM and still falls back when the rest is not UTF-8', () => {
    const body = windows1252(file(line('F1', 'Nuñez', '01/03/2026', '5')));
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...body);

    const result = ok(bytes);
    expect(result.encoding).toBe('windows-1252');
    expect(result.rows[0]?.debtorName).toBe('Nuñez');
  });
});

describe('parseInvoiceCsv: delimiter and quotes', () => {
  it.each([
    [';', 'Factura;Cliente;Fecha;Importe\nF1;Acme;01/03/2026;1.234,56\n'],
    [',', 'Factura,Cliente,Fecha,Importe\nF1,Acme,01/03/2026,"1.234,56"\n'],
    [
      '\t',
      'Factura\tCliente\tFecha\tImporte\nF1\tAcme\t01/03/2026\t1.234,56\n',
    ],
  ])('detects %j', (delimiter, text) => {
    const result = ok(text);

    expect(result.delimiter).toBe(delimiter);
    expect(result.rows[0]).toMatchObject({ number: 'F1', amount: 123456 });
  });

  it('sends a tie between candidates to ";"', () => {
    // Four ";" and four "," on the header line; the last header is an unknown column.
    const result = ok(
      'Factura;Cliente;Fecha;Importe;a,b,c,d,e\nF1;Acme;01/03/2026;5\n',
    );

    expect(result.delimiter).toBe(';');
    expect(result.rows).toHaveLength(1);
  });

  it('does not count delimiters inside quotes when choosing', () => {
    const result = ok(
      '"Factura";"Cliente";"Fecha";"Importe";"a,b,c,d,e,f"\nF1;Acme;01/03/2026;5;x\n',
    );

    expect(result.delimiter).toBe(';');
  });

  it('keeps the delimiter and doubled quotes inside a quoted value', () => {
    const result = ok(file(line('F1', '"Taller; ""El Rápido"", S.L."')));

    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.debtorName).toBe('Taller; "El Rápido", S.L.');
  });

  it('does not split a record at a line break inside quotes, and numbers lines physically', () => {
    const result = ok(
      file(
        line('F1', '"Dos\nlíneas"'),
        line('F2', 'Acme', '31/02/2026'),
        line('F3', 'Acme'),
      ),
    );

    // Header = 1, F1 = lines 2-3, F2 = 4, F3 = 5.
    expect(brief(result.errors)).toEqual([
      [2, 'debtorName', 'CONTROL_CHARS'],
      [4, 'issueDate', 'INVALID_DATE'],
    ]);
    expect(result.rows.map((r) => r.row)).toEqual([5]);
  });

  it('accepts a quoted header', () => {
    const result = ok(
      '"Factura";"Cliente";"Fecha";"Importe"\nF1;Acme;01/03/2026;5\n',
    );

    expect(result.rows).toHaveLength(1);
  });

  it('reports a quote that is never closed as a fatal error', () => {
    expect(fatal(file(line('F1', '"Acme')) + line('F2') + '\n').code).toBe(
      'CSV_MALFORMED',
    );
  });
});

describe('parseInvoiceCsv: line endings and blank lines', () => {
  const lines = [HEADER, line('F1'), line('F2'), line('F3')];

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['lone CR', '\r'],
  ])('reads %s', (_name, eol) => {
    const result = ok(lines.join(eol) + eol);

    expect(result.rows.map((r) => [r.row, r.number])).toEqual([
      [2, 'F1'],
      [3, 'F2'],
      [4, 'F3'],
    ]);
  });

  it('ignores blank lines but keeps the real line numbers', () => {
    const result = ok(
      ['', HEADER, '', line('F1'), '   ', ';;;;', line('F2', 'Acme', 'x')].join(
        '\r\n',
      ),
    );

    expect(result.totalRows).toBe(2);
    expect(result.rows.map((r) => r.row)).toEqual([4]);
    expect(brief(result.errors)).toEqual([[7, 'issueDate', 'INVALID_DATE']]);
  });

  it('counts a CRLF inside a quoted value as one line', () => {
    const result = ok(
      [HEADER, line('F1', '"a\r\nb"'), line('F2', 'Acme', 'x')].join('\r\n'),
    );

    expect(brief(result.errors)).toEqual([
      [2, 'debtorName', 'CONTROL_CHARS'],
      [4, 'issueDate', 'INVALID_DATE'],
    ]);
  });
});

describe('parseInvoiceCsv: headers', () => {
  it('matches Spanish aliases without regard to accents, case or punctuation', () => {
    const result = ok(
      ' FACTURA ;Razón Social;NIF/CIF;Correo;Fecha_Emisión;Fecha.Vencimiento;TOTAL;Observaciones\n' +
        'F1;Acme;b1;a@example.com;01/03/2026;31/03/2026;10;ignorada\n',
    );

    expect(result.rows[0]).toMatchObject({
      number: 'F1',
      debtorName: 'Acme',
      taxId: 'B1',
      email: 'a@example.com',
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      amount: 1000,
    });
  });

  it.each([
    ['Nº'],
    ['N.º'],
    ['N factura'],
    ['número'],
    ['Invoice'],
    ['Number'],
  ])('accepts %j as the invoice number', (header) => {
    const result = ok(
      `${header};Cliente;Fecha;Importe\nF9;Acme;01/03/2026;5\n`,
    );

    expect(result.rows[0]?.number).toBe('F9');
  });

  it('accepts the English aliases', () => {
    const result = ok(
      'invoice,customer,tax id,e-mail,issue date,due date,amount\n' +
        'F1,Acme,b1,a@example.com,2026-03-01,2026-03-31,"10,5"\n',
    );

    expect(result.rows[0]).toMatchObject({ number: 'F1', amount: 1050 });
  });

  it('lists the missing required columns', () => {
    const result = fatal('Factura;Cliente;Total\nF1;Acme;5\n');

    expect(result).toMatchObject({
      code: 'CSV_MISSING_COLUMNS',
      details: { missing: ['issueDate'] },
    });
    expect(fatal('Foo;Bar\n1;2\n')).toMatchObject({
      code: 'CSV_MISSING_COLUMNS',
      details: { missing: ['number', 'debtorName', 'issueDate', 'amount'] },
    });
  });

  it('does not require the optional columns', () => {
    expect(ok(file(line())).rows[0]).toMatchObject({
      taxId: null,
      email: null,
      dueDate: null,
    });
  });

  it('refuses two columns for the same field instead of guessing the amount', () => {
    const result = fatal(
      'Factura;Cliente;Fecha;Importe;Total\nF1;Acme;01/03/2026;5;6\n',
    );

    expect(result).toMatchObject({
      code: 'CSV_DUPLICATE_COLUMNS',
      details: { duplicated: ['amount'] },
    });
  });
});

describe('parseInvoiceCsv: amounts', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,5', 123450],
    ['12,50 €', 1250],
    ['EUR 3', 300],
  ])('parses %j as %i cents', (text, cents) => {
    expect(
      ok(file(line('F1', 'Acme', '01/03/2026', text))).rows[0]?.amount,
    ).toBe(cents);
  });

  it('reports each bad amount on its own row with the reason', () => {
    const result = ok(
      file(
        line('F1', 'Acme', '01/03/2026', '12,345'),
        line('F2', 'Acme', '01/03/2026', '-5'),
        line('F3', 'Acme', '01/03/2026', '0,00'),
        line('F4', 'Acme', '01/03/2026', '1,234E3'),
        line('F5', 'Acme', '01/03/2026', '12,345,67'),
        line('F6', 'Acme', '01/03/2026', 'doce'),
        line('F7', 'Acme', '01/03/2026', '1,234567'),
        line('F8', 'Acme', '01/03/2026', ''),
        line('F9', 'Acme', '01/03/2026', '9'),
      ),
    );

    expect(brief(result.errors)).toEqual([
      [2, 'amount', 'AMOUNT_AMBIGUOUS_SEPARATOR'],
      [3, 'amount', 'AMOUNT_NEGATIVE'],
      [4, 'amount', 'AMOUNT_ZERO'],
      [5, 'amount', 'AMOUNT_EXPONENT'],
      [6, 'amount', 'AMOUNT_INVALID_FORMAT'],
      [7, 'amount', 'AMOUNT_INVALID_FORMAT'],
      [8, 'amount', 'AMOUNT_TOO_MANY_DECIMALS'],
      [9, 'amount', 'REQUIRED'],
    ]);
    expect(result.rows.map((r) => r.number)).toEqual(['F9']);
    expect(result.totalRows).toBe(9);
  });
});

describe('parseInvoiceCsv: dates', () => {
  it.each([
    ['05/01/2026'],
    ['05-01-2026'],
    ['05.01.2026'],
    ['2026-01-05'],
    ['5/1/2026'],
  ])('accepts %j', (text) => {
    expect(ok(file(line('F1', 'Acme', text))).rows[0]?.issueDate).toBe(
      '2026-01-05',
    );
  });

  it('accepts 29 February in a leap year', () => {
    expect(ok(file(line('F1', 'Acme', '29/02/2028'))).rows[0]?.issueDate).toBe(
      '2028-02-29',
    );
  });

  it.each([
    ['31/02/2026'],
    ['29/02/2026'],
    ['00/03/2026'],
    ['10/13/2026'],
    ['01/03/26'],
    ['01/03/026'],
    ['01/03/20260'],
    ['2026/03/01'],
    ['05/01-2026'],
    ['2026-02-30'],
    ['ayer'],
  ])('rejects %j as an issue date', (text) => {
    const result = ok(file(line('F1', 'Acme', text), line('F2')));

    expect(brief(result.errors)).toEqual([[2, 'issueDate', 'INVALID_DATE']]);
    expect(result.rows.map((r) => r.number)).toEqual(['F2']);
  });

  it('requires the issue date but not the due date', () => {
    const result = ok(
      'Factura;Cliente;Fecha;Vencimiento;Importe\n' +
        'F1;Acme;;;5\n' +
        'F2;Acme;01/03/2026;;5\n' +
        'F3;Acme;01/03/2026;32/03/2026;5\n',
    );

    expect(brief(result.errors)).toEqual([
      [2, 'issueDate', 'REQUIRED'],
      [4, 'dueDate', 'INVALID_DATE'],
    ]);
    expect(result.rows).toMatchObject([{ number: 'F2', dueDate: null }]);
  });

  it('rejects a due date before the issue date, but allows the same day', () => {
    const result = ok(
      'Factura;Cliente;Fecha;Vencimiento;Importe\n' +
        'F1;Acme;10/03/2026;09/03/2026;5\n' +
        'F2;Acme;10/03/2026;10/03/2026;5\n',
    );

    expect(brief(result.errors)).toEqual([[2, 'dueDate', 'DUE_BEFORE_ISSUE']]);
    expect(result.rows.map((r) => r.number)).toEqual(['F2']);
  });
});

describe('parseInvoiceCsv: text fields', () => {
  it('normalises the tax id and trims every text value', () => {
    const result = ok(
      'Factura;Cliente;NIF;Fecha;Importe\n' +
        ' F1 ;  Acme  ;  x-12 3.4 ;01/03/2026;5\n',
    );

    expect(result.rows[0]).toMatchObject({
      number: 'F1',
      debtorName: 'Acme',
      taxId: 'X123.4',
    });
  });

  it('requires number and debtor name', () => {
    const result = ok(file(';Acme;01/03/2026;5', 'F2;;01/03/2026;5'));

    expect(brief(result.errors)).toEqual([
      [2, 'number', 'REQUIRED'],
      [3, 'debtorName', 'REQUIRED'],
    ]);
  });

  it('validates the email only when there is one', () => {
    const result = ok(
      'Factura;Cliente;Email;Fecha;Importe\n' +
        'F1;Acme;no-es-un-email;01/03/2026;5\n' +
        'F2;Acme;a@b;01/03/2026;5\n' +
        'F3;Acme;a b@example.com;01/03/2026;5\n' +
        'F4;Acme;;01/03/2026;5\n' +
        'F5;Acme;ok@example.com;01/03/2026;5\n',
    );

    expect(brief(result.errors)).toEqual([
      [2, 'email', 'INVALID_EMAIL'],
      [3, 'email', 'INVALID_EMAIL'],
      [4, 'email', 'INVALID_EMAIL'],
    ]);
    expect(result.rows.map((r) => r.number)).toEqual(['F4', 'F5']);
  });

  it('accepts a value of exactly the maximum length and rejects one more', () => {
    const result = ok(
      file(
        line('F1', 'a'.repeat(MAX_TEXT_LENGTH)),
        line('F2', 'a'.repeat(MAX_TEXT_LENGTH + 1)),
        line('F'.repeat(MAX_TEXT_LENGTH + 1)),
      ),
    );

    expect(brief(result.errors)).toEqual([
      [3, 'debtorName', 'TOO_LONG'],
      [4, 'number', 'TOO_LONG'],
    ]);
    expect(result.rows.map((r) => r.number)).toEqual(['F1']);
  });

  it.each([
    ['a bell', 'Ac\u0007me'],
    ['a NUL', 'Ac\u0000me'],
    ['a tab inside a value', '"Ac\tme"'],
    ['a zero width space', 'Ac​me'],
    ['a right-to-left override', 'Ac‮me'],
  ])('rejects %s in a name', (_label, name) => {
    const result = ok(file(line('F1', name)));

    expect(brief(result.errors)).toEqual([[2, 'debtorName', 'CONTROL_CHARS']]);
    expect(result.rows).toEqual([]);
  });
});

describe('parseInvoiceCsv: formula injection', () => {
  it.each([['=1+1'], ['+34 600'], ['-2+3'], ['@SUM(A1)']])(
    'keeps %j as text and warns',
    (name) => {
      const result = ok(file(line('F1', name)));

      expect(result.errors).toEqual([]);
      expect(result.rows[0]?.debtorName).toBe(name);
      expect(brief(result.warnings)).toEqual([
        [2, 'debtorName', 'FORMULA_PREFIX'],
      ]);
    },
  );

  it('checks the invoice number and tax id as well, but not a safe value', () => {
    const result = ok(
      'Factura;Cliente;NIF;Fecha;Importe\n' +
        '=F1;Acme;-B12;01/03/2026;5\n' +
        'F-2;Acme;B12;01/03/2026;5\n',
    );

    expect(brief(result.warnings)).toEqual([
      [2, 'number', 'FORMULA_PREFIX'],
      [2, 'taxId', 'FORMULA_PREFIX'],
    ]);
    expect(result.rows.map((r) => [r.number, r.taxId])).toEqual([
      ['=F1', 'B12'],
      ['F-2', 'B12'],
    ]);
  });
});

describe('parseInvoiceCsv: duplicates inside the file', () => {
  it('skips the later copy with a warning, even if accents, case or tax id format differ', () => {
    const result = ok(
      'Factura;Cliente;NIF;Fecha;Importe\n' +
        'F1;Muñoz S.L.;b-1;01/03/2026;5\n' +
        'F1;MUNOZ  s.l.;B1;02/03/2026;9\n' +
        'F2;Muñoz S.L.;B1;01/03/2026;5\n',
    );

    expect(result.rows.map((r) => [r.row, r.number])).toEqual([
      [2, 'F1'],
      [4, 'F2'],
    ]);
    expect(brief(result.warnings)).toEqual([
      [3, 'number', 'DUPLICATE_IN_FILE'],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.totalRows).toBe(3);
  });

  it('keeps the same number for another debtor, or the same name with another tax id', () => {
    const result = ok(
      'Factura;Cliente;NIF;Fecha;Importe\n' +
        'F1;Acme;B1;01/03/2026;5\n' +
        'F1;Beta;B1;01/03/2026;5\n' +
        'F1;Acme;B2;01/03/2026;5\n',
    );

    expect(result.rows).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it('only compares valid rows: a row with an error does not hide the next copy', () => {
    const result = ok(file(line('F1', 'Acme', '31/02/2026'), line('F1')));

    expect(result.rows.map((r) => r.row)).toEqual([3]);
    expect(result.warnings).toEqual([]);
  });

  it('uses the same identity as the database (debtorMatchKey)', () => {
    expect(debtorMatchKey('Muñoz S.L.', 'B1')).toBe(
      debtorMatchKey('MUNOZ s.l.', 'b-1'),
    );
  });
});

describe('parseInvoiceCsv: row shape', () => {
  it('reports a row with more values than the header', () => {
    const result = ok(file(line() + ';sobra', line('F2') + ';;'));

    expect(brief(result.errors)).toEqual([[2, null, 'TOO_MANY_COLUMNS']]);
    expect(result.rows.map((r) => r.number)).toEqual(['F2']);
  });

  it('treats a short row as empty values, so the required ones are reported', () => {
    const result = ok(file('F1;Acme'));

    expect(brief(result.errors)).toEqual([
      [2, 'issueDate', 'REQUIRED'],
      [2, 'amount', 'REQUIRED'],
    ]);
  });

  it('reports all the problems of a row, in column order', () => {
    const result = ok(file(';;x;y'));

    expect(brief(result.errors)).toEqual([
      [2, 'number', 'REQUIRED'],
      [2, 'debtorName', 'REQUIRED'],
      [2, 'issueDate', 'INVALID_DATE'],
      [2, 'amount', 'AMOUNT_INVALID_FORMAT'],
    ]);
    expect(result.errors.every((e) => e.message !== '')).toBe(true);
  });
});

describe('parseInvoiceCsv: limits and empty files', () => {
  const manyRows = (count: number) =>
    file(...Array.from({ length: count }, (_, i) => line(`F${String(i)}`)));

  it('accepts 500 rows', () => {
    const result = ok(manyRows(MAX_CSV_ROWS));

    expect(result.rows).toHaveLength(MAX_CSV_ROWS);
    expect(result.totalRows).toBe(MAX_CSV_ROWS);
  });

  it('refuses 501 rows', () => {
    expect(fatal(manyRows(MAX_CSV_ROWS + 1))).toMatchObject({
      code: 'TOO_MANY_ROWS',
      details: { limit: MAX_CSV_ROWS },
    });
  });

  it('does not count blank lines against the limit', () => {
    const text = manyRows(MAX_CSV_ROWS) + '\n\n;;;\n   \n';

    expect(ok(text).totalRows).toBe(MAX_CSV_ROWS);
  });

  it('accepts exactly 1 MB and refuses one byte more', () => {
    const base = encoder.encode(file(line()));
    const padded = (size: number) => {
      const bytes = new Uint8Array(size).fill(0x20);
      bytes.set(base);
      return bytes;
    };

    expect(ok(padded(MAX_CSV_BYTES)).rows).toHaveLength(1);
    expect(fatal(padded(MAX_CSV_BYTES + 1))).toMatchObject({
      code: 'CSV_TOO_LARGE',
      details: { limit: MAX_CSV_BYTES },
    });
  });

  it.each([
    ['no bytes', ''],
    ['only blank lines', '\n\r\n  \n'],
    ['only a header', HEADER + '\n'],
    ['a header and blank lines', HEADER + '\n\n;;;;\n'],
    ['only a BOM', '﻿'],
  ])('reports %s as empty', (_label, text) => {
    expect(fatal(text).code).toBe('CSV_EMPTY');
  });
});

describe('the sample file', () => {
  const result = ok(
    readFileSync(new URL('../../data/sample-invoices.csv', import.meta.url)),
  );

  it('parses with no errors and no warnings', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.delimiter).toBe(';');
    expect(result.rows).toHaveLength(result.totalRows);
  });

  it('has 10 to 12 invoices from six distinct debtors', () => {
    expect(result.rows.length).toBeGreaterThanOrEqual(10);
    expect(result.rows.length).toBeLessThanOrEqual(12);
    const debtors = new Set(
      result.rows.map((r) => debtorMatchKey(r.debtorName, r.taxId)),
    );
    expect(debtors.size).toBe(6);
  });

  it('mixes missing and present due dates and keeps accents', () => {
    expect(result.rows.some((r) => r.dueDate === null)).toBe(true);
    expect(result.rows.some((r) => r.dueDate !== null)).toBe(true);
    expect(result.rows.map((r) => r.debtorName)).toContain(
      'Muñoz y Peña Pruebas S.L.',
    );
    expect(result.rows[0]).toMatchObject({
      number: 'F-2026-001',
      amount: 123456,
    });
  });

  it('only uses the example.com domain for emails', () => {
    const emails = result.rows.flatMap((r) =>
      r.email === null ? [] : [r.email],
    );

    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((email) => email.endsWith('@example.com'))).toBe(true);
  });
});
