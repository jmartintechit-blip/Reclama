import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { importInvoices, previewImport } from '../db/imports.ts';
import { countInvoices, MAX_INVOICES_PER_USER } from '../db/invoices.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import {
  MAX_CSV_BYTES,
  parseInvoiceCsv,
  type FatalCsvCode,
} from '../domain/csv-import.ts';
import type { DefineRoute } from '../http/routes.ts';
import { sendError } from '../middleware/errors.ts';

export const IMPORTS_PATH = '/api/imports';

// The CSV travels as base64 inside a JSON body (so that no layer between the browser and this
// code treats the bytes as text), and base64 needs 4 bytes for every 3. The extra 16 kB covers the
// rest of the JSON. A file bigger than MAX_CSV_BYTES but under this limit reaches the handler
// and gets CSV_TOO_LARGE; anything bigger is refused earlier as PAYLOAD_TOO_LARGE. This is the
// only route that raises the 10 kB limit of the global JSON parser.
export const IMPORT_BODY_LIMIT_BYTES =
  Math.ceil(MAX_CSV_BYTES / 3) * 4 + 16 * 1024;

// Strict base64 (standard alphabet, correct padding): `csv_base64` is never echoed in an error.
// `dry_run` can also come as ?dry_run=true; the import is a dry run if either one says so.
const bodySchema = z.object({
  csv_base64: z.base64(),
  dry_run: z.boolean().optional(),
});
const querySchema = z.object({
  dry_run: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const FATAL_STATUS: Record<FatalCsvCode, number> = {
  CSV_TOO_LARGE: 413,
  TOO_MANY_ROWS: 422,
  CSV_EMPTY: 422,
  CSV_MALFORMED: 422,
  CSV_MISSING_COLUMNS: 422,
  CSV_DUPLICATE_COLUMNS: 422,
};

// The most rows a dry run sends back to be shown as a sample.
const PREVIEW_ROWS = 20;

export function registerImportRoutes(
  defineRoute: DefineRoute,
  { db }: { db: Db },
) {
  defineRoute({
    method: 'POST',
    path: IMPORTS_PATH,
    schema: { body: bodySchema, query: querySchema },
    // 20 per hour per user. It counts after validation, so a malformed request does not use it up.
    rateLimit: {
      name: 'import',
      limit: 20,
      windowSeconds: 60 * 60,
      key: (_body, _ip, session) => hashKeyPart(session.user.id),
    },
    handler: async ({ res, body, query, session }) => {
      const dryRun = body.dry_run === true || query.dry_run;

      // Checked on the encoded text, before the bytes are even allocated.
      if (Buffer.byteLength(body.csv_base64, 'base64') > MAX_CSV_BYTES) {
        sendError(res, 413, 'CSV_TOO_LARGE', 'The file is larger than 1 MB', {
          limit: MAX_CSV_BYTES,
        });
        return;
      }
      const parsed = parseInvoiceCsv(Buffer.from(body.csv_base64, 'base64'));
      if (!parsed.ok) {
        // The parser's message and details describe the problem and never contain file content.
        sendError(
          res,
          FATAL_STATUS[parsed.code],
          parsed.code,
          parsed.message,
          parsed.details,
        );
        return;
      }

      // In a dry run the three counts are what a real import WOULD create or skip.
      const userId = session.user.id;
      const preview = await previewImport(db, userId, parsed.rows);
      // The invoices the user already has plus the new ones must fit in the limit; a dry run
      // reports the same refusal as the real import. Checked before anything is written.
      if (
        (await countInvoices(db, userId)) + preview.invoicesCreated >
        MAX_INVOICES_PER_USER
      ) {
        sendError(
          res,
          422,
          'INVOICE_LIMIT_REACHED',
          'The limit of invoices per account has been reached',
          { limit: MAX_INVOICES_PER_USER },
        );
        return;
      }
      const dryRunResult = dryRun ? preview : null;
      const counts =
        dryRunResult ?? (await importInvoices(db, userId, parsed.rows));

      res.json({
        data: {
          dry_run: dryRun,
          rows_total: parsed.totalRows,
          rows_valid: parsed.rows.length,
          debtors_created: counts.debtorsCreated,
          invoices_created: counts.invoicesCreated,
          invoices_already_imported: counts.invoicesAlreadyImported,
          errors: parsed.errors,
          warnings: parsed.warnings,
          delimiter: parsed.delimiter,
          encoding: parsed.encoding,
          ...(dryRunResult && {
            preview: parsed.rows.slice(0, PREVIEW_ROWS).map((row, index) => ({
              row: row.row,
              number: row.number,
              debtor_name: row.debtorName,
              tax_id: row.taxId,
              email: row.email,
              issue_date: row.issueDate,
              due_date: row.dueDate,
              amount_cents: row.amount,
              already_imported: dryRunResult.alreadyImported[index] ?? false,
            })),
          }),
        },
      });
    },
  });
}
