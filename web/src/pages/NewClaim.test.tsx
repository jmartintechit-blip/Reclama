// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { DebtorKind } from '../lib/api-types.ts';
import {
  CLAIM_ID,
  claimDetail,
  DEBTOR_ID,
  debtor,
  dayFromToday,
  invoice,
  invoicesPage,
  TODAY,
} from '../test/fixtures.ts';
import {
  apiError,
  deferred,
  EMPTY_PROFILE,
  empty,
  json,
  me,
  mockApi,
  networkError,
  type Reply,
} from '../test/mock-api.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const PAGE_URL = `/reclamaciones/nueva?deudor=${DEBTOR_ID}`;
const OPEN = (offset = 0) =>
  `GET /api/invoices?debtor_id=${DEBTOR_ID}&status=OPEN&limit=100&offset=${String(offset)}`;
const DEBTOR = `GET /api/debtors/${DEBTOR_ID}`;
const CREATE = 'POST /api/claims';

const FIRST = invoice();
const SECOND = invoice({
  id: '9d3a0b11-0000-4000-8000-0000000000a2',
  number: 'FA-2025-002',
  amount_cents: 50_000,
  balance_cents: 50_000,
});
const NOT_DUE = invoice({
  id: '4e7c0d33-0000-4000-8000-0000000000a3',
  number: 'FA-2026-009',
  overdue: false,
  days_overdue: 0,
  due_date: dayFromToday(20),
  due_date_effective: dayFromToday(20),
});

interface Script {
  debtorKind?: DebtorKind;
  invoices?: Reply | Reply[];
  debtor?: Reply | Reply[];
  create?: Reply | Reply[];
  profile?: Record<string, unknown>;
  extra?: Record<string, Reply | Reply[]>;
}

function script({
  debtorKind = 'BUSINESS',
  invoices,
  debtor: d,
  create,
  profile,
  extra,
}: Script = {}) {
  return mockApi({
    'GET /api/me': me({}, profile),
    [DEBTOR]:
      d ?? json(200, { data: { debtor: debtor({ kind: debtorKind }) } }),
    [OPEN()]: invoices ?? json(200, invoicesPage([FIRST, SECOND, NOT_DUE])),
    [CREATE]: create ?? json(201, { data: claimDetail() }),
    [`GET /api/claims/${CLAIM_ID}`]: json(200, { data: claimDetail() }),
    ...extra,
  });
}

async function openForm() {
  const router = renderApp(PAGE_URL);
  await screen.findByRole('heading', { level: 1, name: 'Nueva reclamación' });
  await screen.findByRole('button', { name: 'Crear reclamación' });
  return { router, user: userEvent.setup() };
}

const legal = () =>
  screen.getByRole('checkbox', {
    name: /Entiendo que Reclama es una herramienta/,
  });
const summary = () =>
  document.querySelector<HTMLElement>('[data-error-summary]');

describe('NewClaim: what it needs', () => {
  it('says what is missing when there is no debtor in the address', async () => {
    mockApi({ 'GET /api/me': me() });
    renderApp('/reclamaciones/nueva');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Falta elegir el deudor',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Ir a las facturas' })
        .getAttribute('href'),
    ).toBe('/panel');
  });

  it('shows a skeleton while loading', async () => {
    const gate = deferred(json(200, { data: { debtor: debtor() } }));
    script({ debtor: gate.reply });
    renderApp(PAGE_URL);
    expect(
      await screen.findByText('Cargando las facturas del deudor…'),
    ).toBeTruthy();
    gate.release();
    await screen.findByRole('button', { name: 'Crear reclamación' });
  });

  it('says so when the debtor does not exist', async () => {
    script({ debtor: apiError(404, 'NOT_FOUND') });
    renderApp(PAGE_URL);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'No encontramos este deudor',
      }),
    ).toBeTruthy();
  });

  it('offers to retry when the data cannot be loaded, and recovers', async () => {
    script({ invoices: [networkError, json(200, invoicesPage([FIRST]))] });
    renderApp(PAGE_URL);
    const user = userEvent.setup();
    expect(await screen.findByText(/No hemos podido conectar/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(
      await screen.findByRole('button', { name: 'Crear reclamación' }),
    ).toBeTruthy();
  });

  it.each<[DebtorKind, string]>([
    ['CONSUMER', 'Reclama no reclama a consumidores'],
    [
      'PUBLIC_ADMIN',
      'Reclama no tramita reclamaciones a administraciones públicas',
    ],
    ['UNKNOWN', 'Marca al deudor como empresa o autónomo'],
  ])('does not offer the form for a %s debtor', async (kind, text) => {
    script({ debtorKind: kind });
    renderApp(PAGE_URL);
    expect(await screen.findByText(text, { exact: false })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Crear reclamación' }),
    ).toBeNull();
    if (kind === 'UNKNOWN') {
      expect(
        screen
          .getByRole('link', { name: /Abrir una factura de este deudor/ })
          .getAttribute('href'),
      ).toBe(`/facturas/${FIRST.id}`);
    }
  });

  it('says there is nothing to claim when no invoice is overdue', async () => {
    script({ invoices: json(200, invoicesPage([NOT_DUE])) });
    renderApp(PAGE_URL);
    expect(
      await screen.findByRole('heading', {
        name: 'No hay facturas que reclamar',
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Crear reclamación' }),
    ).toBeNull();
  });
});

describe('NewClaim: the form', () => {
  it('lists the overdue invoices, all chosen, and leaves out the ones not due yet', async () => {
    script();
    await openForm();
    const boxes = screen.getAllByRole('checkbox', {
      name: /Incluir la factura/,
    });
    expect(boxes.map((box) => box.getAttribute('type'))).toEqual([
      'checkbox',
      'checkbox',
    ]);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText('FA-2026-009')).toBeNull();
    expect(screen.getByText(/2 de 2 facturas seleccionadas/)).toBeTruthy();
  });

  it('starts on the compensation of the profile and explains the three options in words', async () => {
    script({
      profile: { ...EMPTY_PROFILE, default_compensation: 'PER_INVOICE' },
    });
    await openForm();
    expect(
      screen.getByRole<HTMLInputElement>('radio', {
        name: /40 € por factura vencida/,
      }).checked,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'no deja claro si son 40 € por cada factura o 40 € por toda la reclamación',
    );
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(document.body.textContent).toContain(
      'Se suman 40 € una sola vez por reclamación',
    );
  });

  it('marks and unmarks all the invoices', async () => {
    script();
    const { user } = await openForm();
    await user.click(screen.getByRole('button', { name: 'Desmarcar todas' }));
    expect(screen.getByText(/0 de 2 facturas seleccionadas/)).toBeTruthy();
    await user.click(
      screen.getByRole('checkbox', { name: 'Incluir la factura FA-2025-002' }),
    );
    expect(screen.getByText(/1 de 2 facturas seleccionadas/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Marcar todas' }));
    expect(screen.getByText(/2 de 2 facturas seleccionadas/)).toBeTruthy();
  });

  it('creates the claim, sends only the debtor and the compensation when everything is chosen, and opens it', async () => {
    const api = script();
    const { router, user } = await openForm();
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/reclamaciones/${CLAIM_ID}`);
    });
    expect(api.lastBody(CREATE)).toEqual({
      debtor_id: DEBTOR_ID,
      compensation_mode: 'PER_CLAIM',
    });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Reclamación a Talleres Ejemplo S.L.',
      }),
    ).toBeTruthy();
  });

  it('sends the chosen invoices, the date and the compensation picked', async () => {
    const api = script();
    const { user } = await openForm();
    await user.click(
      screen.getByRole('checkbox', { name: 'Incluir la factura FA-2025-002' }),
    );
    fireEvent.change(screen.getByLabelText('Calcular los intereses hasta'), {
      target: { value: '2026-09-30' },
    });
    await user.click(screen.getByRole('radio', { name: /Sin compensación/ }));
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    await waitFor(() => {
      expect(api.count(CREATE)).toBe(1);
    });
    expect(api.lastBody(CREATE)).toEqual({
      debtor_id: DEBTOR_ID,
      invoice_ids: [FIRST.id],
      as_of: '2026-09-30',
      compensation_mode: 'NONE',
    });
  });

  it('asks for the legal notice before creating anything', async () => {
    const api = script();
    const { user } = await openForm();
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    expect(api.count(CREATE)).toBe(0);
    expect(summary()?.textContent).toContain(
      'Aviso legal: Marca la casilla para continuar.',
    );
    expect(document.activeElement).toBe(legal());
    expect(legal().getAttribute('aria-invalid')).toBe('true');
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    await waitFor(() => {
      expect(api.count(CREATE)).toBe(1);
    });
  });

  it('asks for at least one invoice and refuses a future date', async () => {
    const api = script();
    const { user } = await openForm();
    await user.click(screen.getByRole('button', { name: 'Desmarcar todas' }));
    fireEvent.change(screen.getByLabelText('Calcular los intereses hasta'), {
      target: { value: dayFromToday(3) },
    });
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    expect(api.count(CREATE)).toBe(0);
    expect(summary()?.textContent).toContain(
      'Facturas: Elige al menos una factura.',
    );
    expect(summary()?.textContent).toContain(
      'Fecha de cálculo: La fecha de cálculo no puede ser futura.',
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText('Calcular los intereses hasta'),
    );
  });

  it('reads every page of invoices and refuses more than 100 in one claim', async () => {
    const many = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) =>
        invoice({
          id: `00000000-0000-4000-8000-${String(from + i).padStart(12, '0')}`,
          number: `FA-${String(from + i)}`,
        }),
      );
    const api = script({
      invoices: json(
        200,
        invoicesPage(many(1, 101), { total: 101, limit: 100 }),
      ),
      extra: {
        [OPEN(100)]: json(
          200,
          invoicesPage(many(101, 102), { total: 101, limit: 100, offset: 100 }),
        ),
      },
    });
    const { user } = await openForm();
    expect(screen.getByText(/101 de 101 facturas seleccionadas/)).toBeTruthy();
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    expect(summary()?.textContent).toContain('como máximo 100 facturas');
    expect(api.count(CREATE)).toBe(0);
  });

  it('locks the button while creating, so a double click makes one claim', async () => {
    const gate = deferred(json(201, { data: claimDetail() }));
    const api = script({ create: gate.reply });
    const { user } = await openForm();
    await user.click(legal());
    const button = screen.getByRole('button', { name: 'Crear reclamación' });
    await user.dblClick(button);
    expect(
      (await screen.findByRole('button', { name: 'Creando…' })).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    expect(api.count(CREATE)).toBe(1);
    gate.release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Creando…' })).toBeNull();
    });
  });
});

describe('NewClaim: what the server can refuse', () => {
  const rule = (status: number, code: string, details?: unknown): Reply =>
    json(status, {
      error: { code, message: 'x', request_id: 'req-1', details },
    });

  it.each<[string, Reply, string]>([
    [
      'DEBTOR_NOT_B2B',
      rule(422, 'DEBTOR_NOT_B2B'),
      'no cubre a los consumidores',
    ],
    [
      'DEBTOR_KIND_UNKNOWN',
      rule(422, 'DEBTOR_KIND_UNKNOWN'),
      'Marca primero al deudor como empresa o autónomo',
    ],
    [
      'NOT_OVERDUE',
      rule(422, 'NOT_OVERDUE'),
      'Ninguna de las facturas elegidas estaba vencida',
    ],
    [
      'RATE_WINDOW',
      rule(422, 'RATE_WINDOW', { missing_semesters: ['2026-H2', '2027-H1'] }),
      'faltan los tipos de demora del BOE de segundo semestre de 2026 y primer semestre de 2027',
    ],
    [
      'CLAIM_TOO_LARGE',
      rule(422, 'CLAIM_TOO_LARGE', { limit: 100 }),
      'como máximo 100 facturas',
    ],
    [
      'INVOICE_IN_CLAIM',
      rule(409, 'INVOICE_IN_CLAIM'),
      'ya está en otra reclamación',
    ],
    [
      '404',
      apiError(404, 'DEBTOR_NOT_FOUND'),
      'No encontramos el deudor o alguna de las facturas',
    ],
    ['429 without a JSON body', empty(429), 'Demasiados intentos'],
    ['a dead network', networkError, 'No hemos podido conectar'],
    ['a 500', apiError(500, 'INTERNAL'), 'Algo ha fallado de nuestro lado'],
  ])(
    'shows %s in Spanish, in the summary, and lets the person try again',
    async (_name, reply, text) => {
      script({ create: reply });
      const { user } = await openForm();
      await user.click(legal());
      await user.click(
        screen.getByRole('button', { name: 'Crear reclamación' }),
      );
      await waitFor(() => {
        expect(summary()?.textContent).toContain(text);
      });
      expect(document.activeElement).toBe(summary());
      expect(
        screen
          .getByRole('button', { name: 'Crear reclamación' })
          .hasAttribute('disabled'),
      ).toBe(false);
    },
  );

  it('pins AS_OF_IN_FUTURE to the date field and focuses it', async () => {
    script({ create: rule(422, 'AS_OF_IN_FUTURE') });
    const { user } = await openForm();
    fireEvent.change(screen.getByLabelText('Calcular los intereses hasta'), {
      target: { value: TODAY },
    });
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    const field = screen.getByLabelText('Calcular los intereses hasta');
    await waitFor(() => {
      expect(field.getAttribute('aria-invalid')).toBe('true');
    });
    expect(document.activeElement).toBe(field);
    expect(document.body.textContent).toContain(
      'La fecha de cálculo no puede ser futura.',
    );
  });

  it('pins a validation error to its field', async () => {
    script({
      create: rule(400, 'VALIDATION_ERROR', [
        { path: 'as_of', message: 'Invalid' },
      ]),
    });
    const { user } = await openForm();
    fireEvent.change(screen.getByLabelText('Calcular los intereses hasta'), {
      target: { value: '2026-09-30' },
    });
    await user.click(legal());
    await user.click(screen.getByRole('button', { name: 'Crear reclamación' }));
    await waitFor(() => {
      expect(
        screen
          .getByLabelText('Calcular los intereses hasta')
          .getAttribute('aria-invalid'),
      ).toBe('true');
    });
    expect(summary()?.textContent).toContain(
      'Fecha de cálculo: Revisa este campo.',
    );
  });
});
