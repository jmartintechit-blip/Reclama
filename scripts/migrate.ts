import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadMigrations, runMigrations } from '../server/db/migrate.ts';

const url = process.env.DATABASE_URL;
// The value is a secret, so the message never includes it.
if (!url?.startsWith('postgres://') && !url?.startsWith('postgresql://')) {
  console.error(
    'DATABASE_URL is missing or is not a postgres:// URL. Set it in .env (see .env.example).',
  );
  process.exit(1);
}

// One dedicated connection (not a pool): the runner needs BEGIN and COMMIT on the same one.
const client = new Client({
  connectionString: url,
  connectionTimeoutMillis: 15_000,
});
try {
  await client.connect();
  const migrationsDir = fileURLToPath(
    new URL('../server/db/migrations', import.meta.url),
  );
  const applied = await runMigrations(
    client,
    await loadMigrations(migrationsDir),
  );
  console.log(
    applied.length > 0
      ? `Applied: ${applied.join(', ')}`
      : 'Database is up to date',
  );
} catch (error) {
  console.error(
    `Migration failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
