import { readFile } from 'node:fs/promises';
import { parseRates, verifyRates } from '../server/domain/rates.ts';

// Offline on purpose (no network, no database): it runs in CI on every push.
try {
  const file = new URL('../data/legal-interest-rates.json', import.meta.url);
  const rows = parseRates(JSON.parse(await readFile(file, 'utf8')));
  const problems = verifyRates(rows);
  if (problems.length > 0) {
    console.error(`Rate table has ${String(problems.length)} problem(s):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`Rate table OK: ${String(rows.length)} semesters`);
  }
} catch (error) {
  console.error(
    `Rate table unreadable: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
}
