import type { LegalRate } from '../domain/rates.ts';
import type { Db } from './client.ts';

// Reference data shared by all users (no user_id). Only VERIFIED rows: a PENDING row counts as
// absent everywhere (the interest engine ignores it too). About 20 rows, oldest first.
export async function listVerifiedRates(db: Db): Promise<LegalRate[]> {
  const { rows } = await db.query(
    `select semester_start, semester_end, rate_bp, ecb_mro_bp, spread_bp, boe_ref,
            published_on, status
       from legal_interest_rates
      where status = 'VERIFIED'
      order by semester_start`,
  );
  return rows as LegalRate[];
}
