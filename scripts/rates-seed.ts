import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { seedRates } from '../server/db/rates-seed.ts';
import { parseRates, verifyRates } from '../server/domain/rates.ts';

// The database is shared by every build: a deploy preview must not change the live rate table.
if (process.env.CONTEXT === 'deploy-preview') {
  console.log('Deploy preview: rates seed skipped');
  process.exit(0);
}

const url = process.env.DATABASE_URL;
// The value is a secret, so the message never includes it.
if (!url?.startsWith('postgres://') && !url?.startsWith('postgresql://')) {
  console.error(
    'DATABASE_URL is missing or is not a postgres:// URL. Set it in .env (see .env.example).',
  );
  process.exit(1);
}

// One dedicated connection (not a pool): the seed needs BEGIN and COMMIT on the same one.
const client = new Client({
  connectionString: url,
  connectionTimeoutMillis: 15_000,
});
try {
  const file = new URL('../data/legal-interest-rates.json', import.meta.url);
  const rows = parseRates(JSON.parse(await readFile(file, 'utf8')));
  // The database does not check that the semesters are contiguous, so check before writing.
  const problems = verifyRates(rows);
  if (problems.length > 0) {
    throw new Error(`Invalid rate table: ${problems.join('; ')}`);
  }
  await client.connect();
  await seedRates(client, rows);
  console.log(`Seeded ${String(rows.length)} legal interest rates`);
} catch (error) {
  console.error(
    `Rate seed failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
