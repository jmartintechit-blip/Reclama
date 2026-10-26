// End-to-end check of the demo flow in a real browser: demo -> invoice -> claim -> PDF letter ->
// escalation step -> email (sandbox) -> cancel. It starts the in-memory API and the Vite dev server
// itself (unless they already answer), so it needs no database and no account. The browser is the
// installed Chrome (E2E_CHANNEL=msedge for Edge). Exits 1 on the first failed expectation.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { type Browser, chromium, expect } from '@playwright/test';

const API = 'http://127.0.0.1:3000/api/health';
const BASE = 'http://localhost:5173';
const started: ChildProcess[] = [];
let browser: Browser | undefined;

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function ensure(url: string, args: string[]): Promise<void> {
  if (await answers(url)) return;
  started.push(spawn(process.execPath, args, { stdio: 'inherit' }));
  for (let i = 0; i < 120; i += 1) {
    if (await answers(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Nothing answered at ${url} after 60 s`);
}

async function stop(): Promise<void> {
  for (const child of started) {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
}

try {
  await ensure(API, ['server/dev-memory.ts']);
  await ensure(BASE, ['node_modules/vite/bin/vite.js', 'web']);

  browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL ?? 'chrome',
  });
  const page = await (
    await browser.newContext({ locale: 'es-ES', colorScheme: 'light' })
  ).newPage();
  const loud: string[] = [];
  page.on('pageerror', (error) => loud.push(error.message));

  await page.goto(`${BASE}/demo`);
  await page.getByRole('button', { name: 'Empezar la demo' }).click();
  await expect(page).toHaveURL(/\/panel$/);
  await expect(page.getByText('Modo demo')).toBeVisible();
  await expect(page.getByText('18.544,65')).toBeVisible();

  const invoiceId = await page.evaluate(async () => {
    const found = (await fetch('/api/invoices?limit=100').then((r) =>
      r.json(),
    )) as { data: { invoices: { id: string; number: string }[] } };
    return found.data.invoices.find((i) => i.number === 'FA-2025-001')?.id;
  });
  await page.goto(`${BASE}/facturas/${invoiceId ?? ''}`);
  await expect(
    page.getByRole('heading', { name: 'Factura FA-2025-001' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: /Los mismos tramos/ }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Crear reclamación' }).click();
  await expect(page).toHaveURL(/\/reclamaciones\/nueva\?deudor=/);
  await page.getByLabel(/Entiendo que Reclama/).check();
  await page.getByRole('button', { name: 'Crear reclamación' }).click();
  await expect(
    page.getByRole('heading', { name: 'Reclamación a Talleres Ejemplo S.L.' }),
  ).toBeVisible();
  await expect(page.getByText('2.897,40')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Descargar carta (PDF)' }).click(),
  ]);
  // A claim with several invoices is named after the claim, not after one invoice.
  expect(download.suggestedFilename()).toMatch(
    /^requerimiento-[0-9a-f]{8}\.pdf$/,
  );
  const file = await download.path();
  expect((await readFile(file)).subarray(0, 5).toString('latin1')).toBe(
    '%PDF-',
  );

  await expect(
    page.getByRole('heading', { name: 'Envía un recordatorio amable' }),
  ).toBeVisible();
  await page.getByLabel('Tipo de paso').selectOption('REMINDER_SENT');
  await page.getByRole('button', { name: 'Registrar paso' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Envía el requerimiento formal de pago',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Enviar la carta por email' }).click();
  await expect(
    page.getByText('Envío de prueba: el deudor no ha recibido nada.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Cancelar reclamación' }).click();
  await page
    .getByRole('button', { name: 'Sí, cancelar la reclamación' })
    .click();
  await expect(page).toHaveURL(/\/reclamaciones$/);
  await expect(page.getByText('Reclamación cancelada.')).toBeVisible();

  expect(loud).toEqual([]);
  console.log('E2E demo flow: OK');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Also on failure: an open browser would keep the process (and the CI job) alive.
  await browser?.close();
  await stop();
}
