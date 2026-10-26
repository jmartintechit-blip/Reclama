// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiError, json, me, mockApi, type Reply } from '../test/mock-api.ts';
import {
  DEBTOR_ID,
  debtor,
  debtorsPage,
  detail,
  INVOICE_ID,
  interest,
} from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const DEBTORS = 'GET /api/debtors?limit=100&offset=0';
const CREATE = 'POST /api/invoices';
const PATCH = `PATCH /api/invoices/${INVOICE_ID}`;

function script(extra: Record<string, Reply | Reply[]> = {}, debtors = true) {
  return mockApi({
    'GET /api/me': me(),
    [DEBTORS]: json(200, debtorsPage(debtors ? [debtor()] : [])),
    [CREATE]: json(201, { data: detail() }),
    [`GET /api/invoices/${INVOICE_ID}`]: json(200, { data: detail() }),
    [`GET /api/invoices/${INVOICE_ID}/interest`]: json(200, {
      data: interest(),
    }),
    [`GET /api/debtors/${DEBTOR_ID}`]: json(200, {
      data: { debtor: debtor() },
    }),
    ...extra,
  });
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);

async function openNew(debtors = true) {
  const api = script({}, debtors);
  renderApp('/facturas/nueva');
  await screen.findByRole('heading', { level: 1, name: 'Nueva factura' });
  return { api, user: userEvent.setup() };
}

async function fillCommon(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field('Número de factura'), 'FA-9');
  await user.type(field('Fecha de emisión'), '2026-03-01');
  await user.type(field('Importe (€)'), '1.234,56');
}

describe('InvoiceForm: new invoice', () => {
  it('creates an invoice for an existing debtor and opens it', async () => {
    const { api, user } = await openNew();
    await user.selectOptions(field('Deudor'), DEBTOR_ID);
    await fillCommon(user);
    await user.type(field('Fecha de vencimiento (opcional)'), '2026-03-31');
    await user.click(screen.getByRole('button', { name: 'Crear factura' }));

    await screen.findByRole('heading', { level: 1, name: /Factura/ });
    expect(api.lastBody(CREATE)).toEqual({
      number: 'FA-9',
      issue_date: '2026-03-01',
      due_date: '2026-03-31',
      amount_cents: 123_456,
      debtor_id: DEBTOR_ID,
    });
  });

  it('creates a new debtor together with the invoice, with the optional fields left out', async () => {
    const { api, user } = await openNew();
    await user.selectOptions(field('Deudor'), 'new');
    await user.type(
      field('Nombre o razón social del deudor'),
      '  Nuevo Cliente S.L. ',
    );
    await user.type(field('Email del deudor (opcional)'), 'Pagos@Cliente.test');
    await fillCommon(user);
    await user.click(screen.getByRole('button', { name: 'Crear factura' }));

    await waitFor(() => {
      expect(api.count(CREATE)).toBe(1);
    });
    expect(api.lastBody(CREATE)).toEqual({
      number: 'FA-9',
      issue_date: '2026-03-01',
      amount_cents: 123_456,
      debtor: { name: 'Nuevo Cliente S.L.', email: 'pagos@cliente.test' },
    });
  });

  it('starts on "new debtor" when the account has none yet', async () => {
    await openNew(false);
    expect(field('Nombre o razón social del deudor')).toBeTruthy();
  });

  it('sends nothing and says what is missing', async () => {
    const { api, user } = await openNew();
    await user.click(screen.getByRole('button', { name: 'Crear factura' }));

    expect(api.count(CREATE)).toBe(0);
    const alert = document.querySelector('.form-alert');
    expect(alert?.textContent).toContain('Deudor: Elige un deudor.');
    expect(alert?.textContent).toContain(
      'Número de factura: Escribe el número de factura.',
    );
    expect(alert?.textContent).toContain(
      'Importe: Escribe el importe de la factura.',
    );
  });

  it('refuses a due date before the issue date without calling the server', async () => {
    const { api, user } = await openNew();
    await user.selectOptions(field('Deudor'), DEBTOR_ID);
    await fillCommon(user);
    await user.type(field('Fecha de vencimiento (opcional)'), '2026-02-01');
    await user.click(screen.getByRole('button', { name: 'Crear factura' }));

    expect(api.count(CREATE)).toBe(0);
    expect(
      screen.getAllByText('El vencimiento no puede ser anterior a la emisión.')
        .length,
    ).toBeGreaterThan(0);
  });

  it('shows a duplicate number next to its field', async () => {
    const api = script({ [CREATE]: apiError(409, 'INVOICE_DUPLICATE') });
    renderApp('/facturas/nueva');
    await screen.findByRole('heading', { level: 1, name: 'Nueva factura' });
    const user = userEvent.setup();
    await user.selectOptions(field('Deudor'), DEBTOR_ID);
    await fillCommon(user);
    await user.click(screen.getByRole('button', { name: 'Crear factura' }));

    await waitFor(() => {
      expect(api.count(CREATE)).toBe(1);
    });
    expect(
      (
        await screen.findAllByText(
          'Este deudor ya tiene una factura con este número.',
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(field('Número de factura').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });
});

describe('InvoiceForm: edit invoice', () => {
  async function openEdit(extra: Record<string, Reply | Reply[]> = {}) {
    const api = script(extra);
    renderApp(`/facturas/${INVOICE_ID}/editar`);
    await screen.findByRole('heading', {
      level: 1,
      name: 'Editar factura FA-2025-001',
    });
    return { api, user: userEvent.setup() };
  }

  it('starts from the stored values and sends them back, clearing an emptied due date', async () => {
    const { api, user } = await openEdit({
      [PATCH]: json(200, { data: detail() }),
    });
    expect(field('Número de factura').value).toBe('FA-2025-001');
    expect(field('Importe (€)').value).toBe('1842,50');
    await screen.findByText('Talleres Ejemplo S.L.');

    await user.clear(field('Fecha de vencimiento (opcional)'));
    await user.clear(field('Importe (€)'));
    await user.type(field('Importe (€)'), '2000');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await screen.findByRole('heading', { level: 1, name: /Factura/ });
    expect(api.lastBody(PATCH)).toMatchObject({
      number: 'FA-2025-001',
      due_date: null,
      amount_cents: 200_000,
    });
  });

  it('says how much has been collected when the new amount is lower', async () => {
    const { user } = await openEdit({
      [PATCH]: apiError(422, 'AMOUNT_BELOW_PAID'),
    });
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(
      (await screen.findAllByText(/No puede ser menos de lo ya cobrado/))
        .length,
    ).toBeGreaterThan(0);
  });

  it('explains that an invoice in a claim cannot change', async () => {
    const { user } = await openEdit({
      [PATCH]: apiError(409, 'INVOICE_IN_CLAIM'),
    });
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText(/ya no admite cambios/)).toBeTruthy();
  });
});
