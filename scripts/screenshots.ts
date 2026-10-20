// Takes the README screenshots of the demo into docs/images. It does not start anything: run
// `npm run dev:memory` and `npm run web:dev` first, then `npm run screenshots`. It drives the
// installed Edge (no browser download) through the demo, so every figure is the fictitious data.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = new URL('../docs/images/', import.meta.url);
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: 'light',
  locale: 'es-ES',
});
const page = await context.newPage();

const shot = async (name: string, target: Page = page) =>
  target.screenshot({ path: fileURLToPath(new URL(`${name}.png`, OUT)) });

await page.goto(`${BASE}/demo`);
await page.getByRole('button', { name: 'Empezar la demo' }).click();
await page.waitForURL('**/panel');
await page.getByRole('table').waitFor();
await shot('dashboard');

const ids = await page.evaluate(async () => {
  const get = async <T>(url: string): Promise<T> =>
    (await fetch(url).then((r) => r.json())) as T;
  const { data: found } = await get<{
    data: { invoices: { id: string; number: string }[] };
  }>('/api/invoices?limit=100');
  const { data: owed } = await get<{
    data: { debtors: { id: string; name: string }[] };
  }>('/api/debtors');
  const debtor = owed.debtors.find((d) => d.name.startsWith('Talleres'));
  const claim = (await fetch('/api/claims', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtor?.id }),
  }).then((r) => r.json())) as { data: { claim: { id: string } } };
  return {
    invoice: found.invoices.find((i) => i.number === 'FA-2025-001')?.id,
    claim: claim.data.claim.id,
  };
});

await page.goto(`${BASE}/facturas/${ids.invoice ?? ''}`);
await page.getByRole('heading', { level: 1 }).waitFor();
await page.waitForTimeout(2000); // the curve reveal animation lasts 1.4 s
// Tall enough to show the whole interest curve.
await page.setViewportSize({ width: 1280, height: 1250 });
await shot('invoice-interest');
await page.setViewportSize({ width: 1280, height: 800 });

await page.goto(`${BASE}/reclamaciones/${ids.claim}`);
await page.getByRole('heading', { name: 'Siguiente paso' }).waitFor();
await page
  .getByRole('heading', { name: 'Siguiente paso' })
  .scrollIntoViewIfNeeded();
await shot('claim-guide');

const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: 'light',
  locale: 'es-ES',
  deviceScaleFactor: 2,
});
const small = await phone.newPage();
await small.goto(`${BASE}/demo`);
await small.getByRole('button', { name: 'Empezar la demo' }).click();
await small.waitForURL('**/panel');
await small.getByRole('table').waitFor();
await shot('dashboard-mobile', small);

await browser.close();
