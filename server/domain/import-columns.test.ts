// The import screen explains which column names the CSV importer understands
// (web/src/content/import-columns.ts) and offers a sample file (web/public/facturas-ejemplo.csv).
// Both are copies of what the server decides, so this test feeds them to the real parser: a name
// the screen promises but the parser rejects, or a sample that stops importing cleanly, fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  type ImportColumn,
} from '../../web/src/content/import-columns.ts';
import { parseInvoiceCsv } from './csv-import.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

// One data row that is valid for every column, keyed by the canonical field.
const VALUES: Record<ImportColumn['field'], string> = {
  number: 'F-1',
  debtorName: 'Talleres Ejemplo S.L.',
  taxId: 'B00000001',
  email: 'talleres@example.com',
  issueDate: '15/01/2026',
  dueDate: '14/02/2026',
  amount: '1.234,56',
};

// A file whose header uses `name` for `column` and the canonical title for every other column.
function fileWith(column: ImportColumn, name: string): Uint8Array {
  const names = IMPORT_COLUMNS.map((c) => (c === column ? name : c.title));
  const values = IMPORT_COLUMNS.map((c) => VALUES[c.field]);
  return bytes(`${names.join(';')}\n${values.join(';')}\n`);
}

describe('columns explained by the import screen', () => {
  const cases = IMPORT_COLUMNS.flatMap((column) =>
    [column.title, ...column.aliases].map(
      (name): [string, string, ImportColumn] => [column.field, name, column],
    ),
  );

  it.each(cases)(
    '%s: the parser understands the header "%s"',
    (field, name, column) => {
      const result = parseInvoiceCsv(fileWith(column, name));
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.errors).toEqual([]);
      const row = result.rows[0];
      // A column that was not recognised would silently leave its value empty.
      expect(row).toBeDefined();
      if (field === 'taxId') expect(row?.taxId).toBe('B00000001');
      if (field === 'email') expect(row?.email).toBe('talleres@example.com');
      if (field === 'dueDate') expect(row?.dueDate).toBe('2026-02-14');
      if (field === 'amount') expect(row?.amount).toBe(123_456);
      if (field === 'number') expect(row?.number).toBe('F-1');
      if (field === 'debtorName')
        expect(row?.debtorName).toBe(VALUES.debtorName);
      if (field === 'issueDate') expect(row?.issueDate).toBe('2026-01-15');
    },
  );

  it('marks as required exactly the columns the parser refuses to go without', () => {
    for (const column of IMPORT_COLUMNS) {
      const names = IMPORT_COLUMNS.filter((c) => c !== column).map(
        (c) => c.title,
      );
      const values = IMPORT_COLUMNS.filter((c) => c !== column).map(
        (c) => VALUES[c.field],
      );
      const result = parseInvoiceCsv(
        bytes(`${names.join(';')}\n${values.join(';')}\n`),
      );
      expect(result.ok, column.field).toBe(!column.required);
    }
  });
});

describe('the sample CSV offered for download', () => {
  const repo = readFileSync(
    new URL('../../data/sample-invoices.csv', import.meta.url),
  );
  const published = readFileSync(
    new URL('../../web/public/facturas-ejemplo.csv', import.meta.url),
  );

  it('is byte for byte the sample of the repository', () => {
    expect(published.equals(repo)).toBe(true);
  });

  it('imports without a single error or warning', () => {
    const result = parseInvoiceCsv(new Uint8Array(published));
    if (!result.ok) throw new Error(result.message);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(11);
    expect(result.encoding).toBe('utf-8');
  });
});
