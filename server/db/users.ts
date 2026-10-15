import type { Db } from './client.ts';

export interface NewUser {
  id: string;
  email: string;
}

export interface LoginUser {
  id: string;
  email: string;
  password_hash: string | null;
}

// Postgres error code for "unique constraint violated". Both pg and PGlite put it in `error.code`.
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

// The user and its empty profile are created by ONE statement (a CTE), because Db has no
// transactions: a user without a profile can never exist. Returns null when the email is
// already registered. The check is the unique constraint itself, so two requests that race
// for the same email cannot both succeed.
export async function createUserWithProfile(
  db: Db,
  email: string,
  passwordHash: string,
): Promise<NewUser | null> {
  try {
    const { rows } = await db.query(
      `with new_user as (
         insert into users (email, password_hash) values ($1, $2) returning id, email
       ), new_profile as (
         insert into profiles (user_id) select id from new_user
       )
       select id, email from new_user`,
      [email, passwordHash],
    );
    return rows[0] as NewUser;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<LoginUser | null> {
  const { rows } = await db.query(
    'select id, email, password_hash from users where email = $1',
    [email],
  );
  return (rows[0] as LoginUser | undefined) ?? null;
}

// null for a user without a password (a demo user) or without a row.
export async function getPasswordHash(
  db: Db,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query(
    'select password_hash from users where id = $1',
    [userId],
  );
  const row = rows[0] as { password_hash: string | null } | undefined;
  return row?.password_hash ?? null;
}

// Right to erasure: deleting the users row removes every row of that user in every table
// (each one has user_id -> users ON DELETE CASCADE). Returns false when there was no such user.
export async function deleteUser(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    'delete from users where id = $1 returning id',
    [userId],
  );
  return rows.length > 0;
}

// Compare-and-set on the old hash: if the password changed in the meantime, this does nothing.
export async function replacePasswordHash(
  db: Db,
  userId: string,
  oldHash: string,
  newHash: string,
): Promise<void> {
  await db.query(
    'update users set password_hash = $3 where id = $1 and password_hash = $2',
    [userId, oldHash, newHash],
  );
}
