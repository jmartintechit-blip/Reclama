import type { Db } from './client.ts';
import { buildSet } from './query-helpers.ts';

export type Compensation = 'NONE' | 'PER_INVOICE' | 'PER_CLAIM';

export interface Profile {
  business_name: string | null;
  tax_id: string | null;
  address: string | null;
  iban: string | null;
  default_compensation: Compensation;
}

// A key left out (or undefined) keeps the stored value; null clears a text field. The
// compensation mode cannot be cleared: the column is not nullable.
export interface ProfilePatch {
  business_name?: string | null;
  tax_id?: string | null;
  address?: string | null;
  iban?: string | null;
  default_compensation?: Compensation;
}

const COLUMNS = 'business_name, tax_id, address, iban, default_compensation';

// null when the user has no profile row (registration always creates one).
export async function getProfile(
  db: Db,
  userId: string,
): Promise<Profile | null> {
  const { rows } = await db.query(
    `select ${COLUMNS} from profiles where user_id = $1`,
    [userId],
  );
  return (rows[0] as Profile | undefined) ?? null;
}

export async function updateProfile(
  db: Db,
  userId: string,
  patch: ProfilePatch,
): Promise<Profile | null> {
  const { sets, params } = buildSet(
    patch,
    ['business_name', 'tax_id', 'address', 'iban', 'default_compensation'],
    2,
  );
  if (sets === '') return getProfile(db, userId);
  const { rows } = await db.query(
    `update profiles set ${sets} where user_id = $1 returning ${COLUMNS}`,
    [userId, ...params],
  );
  return (rows[0] as Profile | undefined) ?? null;
}
