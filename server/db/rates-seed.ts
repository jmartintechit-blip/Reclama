import type { LegalRate } from '../domain/rates.ts';
import type { Queryable } from './migrate.ts';

const UPSERT = `insert into legal_interest_rates
    (semester_start, semester_end, rate_bp, ecb_mro_bp, spread_bp, boe_ref, published_on, status)
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (semester_start) do update set
    semester_end = excluded.semester_end,
    rate_bp = excluded.rate_bp,
    ecb_mro_bp = excluded.ecb_mro_bp,
    spread_bp = excluded.spread_bp,
    boe_ref = excluded.boe_ref,
    published_on = excluded.published_on,
    status = excluded.status`;

// Idempotent: running it twice leaves the same table. All rows go in one transaction, so a bad
// row leaves the table as it was. `db` must be ONE dedicated connection (see Queryable).
export async function seedRates(
  db: Queryable,
  rows: readonly LegalRate[],
): Promise<void> {
  await db.query('begin');
  try {
    for (const row of rows) {
      await db.query(UPSERT, [
        row.semester_start,
        row.semester_end,
        row.rate_bp,
        row.ecb_mro_bp,
        row.spread_bp,
        row.boe_ref,
        row.published_on,
        row.status,
      ]);
    }
    await db.query('commit');
  } catch (error) {
    // If the rollback fails too (lost connection), the original error is the useful one.
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}
