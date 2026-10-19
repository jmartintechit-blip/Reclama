// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  deferred,
  json,
  me,
  mockApi,
  networkError,
  type Reply,
} from '../test/mock-api.ts';
import {
  DEBTOR_ID,
  debtor,
  detail,
  INVOICE_ID,
  interest,
  payment,
  TODAY,
} from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const NBSP = ' ';
const INVOICE = `GET /api/invoices/${INVOICE_ID}`;
const INTEREST = `${INVOICE}/interest`;
const DEBTOR = `GET /api/debtors/${DEBTOR_ID}`;
const PAY = `POST /api/invoices/${INVOICE_ID}/payments`;
const PATCH_DEBTOR = `PATCH /api/debtors/${DEBTOR_ID}`;

const PAID_ONCE = detail({ paid_cents: 50_000, balance_cents: 134_250 }, [
  payment(),
]);

interface Script {
  invoice?: Reply | Reply[];
  interest?: Reply | Reply[];
  debtor?: Reply | Reply[];
  extra?: Record<string, Reply | Reply[]>;
}

function script({ invoice, interest: i, debtor: d, extra }: Script = {}) {
  return mockApi({
    'GET /api/me': me(),
    [INVOICE]: invoice ?? json(200, { data: PAID_ONCE }),
    [INTEREST]: i ?? json(200, { data: interest() }),
    [DEBTOR]: d ?? json(200, { data: { debtor: debtor() } }),
    ...extra,
  });
}

async function openInvoice() {
  const router = renderApp(`/facturas/${INVOICE_ID}`);
  await screen.findByRole('heading', {
    level: 1,
    name: 'Factura FA-2025-001',
  });
  // The debtor loads after the invoice: wait for its section too.
  await screen.findByRole('radio', { name: 'Empresa o autónomo (B2B)' });
  await waitFor(() => {
    expect(screen.queryByText('Calculando los intereses…')).toBeNull();
  });
  return { router, user: userEvent.setup() };
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const claim = () => screen.getByText('Crear reclamación');
const apiFail = (status: number, code: string, details: unknown): Reply =>
  json(status, {
    error: { code, message: 'x', request_id: 'req-1', details },
  });

describe('InvoiceDetail: the invoice', () => {
  it('shows the skeleton while it loads, then the heading, state, debtor and the four figures', async () => {
    const gate = deferred(json(200, { data: PAID_ONCE }));
    script({ invoice: gate.reply });
    renderApp(`/facturas/${INVOICE_ID}`);
    expect(await screen.findByText('Cargando la factura…')).toBeTruthy();
    gate.release();

    await screen.findByRole('heading', {
      level: 1,
      name: 'Factura FA-2025-001',
    });
    expect(document.title).toBe('Factura FA-2025-001 · Reclama');
    expect(
      await screen.findByText('Talleres Ejemplo S.L.', { selector: 'p' }),
    ).toBeTruthy();
    expect(document.querySelector('.badge')?.textContent).toBe('Vencida');

    const facts = document.querySelector('.facts')?.textContent ?? '';
    expect(facts).toContain(`Importe1.842,50${NBSP}€`);
    expect(facts).toContain(`Cobrado500,00${NBSP}€1 cobro`);
    expect(facts).toContain(`Pendiente1.342,50${NBSP}€venció el`);
    await waitFor(() => {
      expect(document.querySelector('.facts')?.textContent).toContain(
        `Intereses a 19/10/2026178,94${NBSP}€398 días en 4 tramos`,
      );
    });
  });

  it('has a back link to the list and keeps "Facturas" highlighted in the menu', async () => {
    script();
    await openInvoice();
    expect(
      screen
        .getByRole('link', { name: /Ver todas las facturas/ })
        .getAttribute('href'),
    ).toBe('/panel');
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(
      within(nav)
        .getByRole('link', { name: 'Facturas' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('answers "not found" in plain words, with the way back', async () => {
    script({ invoice: apiError(404, 'NOT_FOUND') });
    renderApp(`/facturas/${INVOICE_ID}`);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'No encontramos esta factura',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Ver todas las facturas/ }),
    ).toBeTruthy();
  });

  it('offers to retry when the invoice cannot be loaded', async () => {
    script({ invoice: [networkError, json(200, { data: PAID_ONCE })] });
    renderApp(`/facturas/${INVOICE_ID}`);
    const button = await screen.findByRole('button', { name: 'Reintentar' });
    expect(document.body.textContent).toContain('No hemos podido conectar');
    await userEvent.setup().click(button);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Factura FA-2025-001',
      }),
    ).toBeTruthy();
  });
});

describe('InvoiceDetail: interest breakdown and Timeline', () => {
  it('draws the segments as a list, a Timeline and a table with a total', async () => {
    script();
    await openInvoice();
    const list = screen.getByRole('list', { name: 'Tramos de intereses' });
    expect(list.querySelectorAll('li.seg')).toHaveLength(4);
    const labels = [...list.querySelectorAll('li.ev b')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual([
      'Vencimiento',
      'Nuevo semestre',
      'Cobro',
      'Cambia el tipo',
      'Fecha de cálculo',
    ]);
    expect(list.textContent).toContain(`Cobro el 15/04/2026, 500,00${NBSP}€`);
    expect(list.textContent).toContain(`10,15${NBSP}% a 10,40${NBSP}%`);

    const table = screen.getByRole('table', {
      name: 'Los mismos tramos en forma de tabla',
    });
    const body = within(table).getAllByRole('row');
    // header + four segments + total
    expect(body).toHaveLength(6);
    expect(body[1]?.textContent).toContain('17/09/2025');
    expect(body[1]?.textContent).toContain(`10,15${NBSP}%`);
    expect(body[3]?.textContent).toContain(`1.342,50${NBSP}€`);
    expect(body[5]?.textContent).toBe(`Total178,94${NBSP}€`);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Desde', 'Hasta', 'Días', 'Tipo', 'Saldo', 'Intereses']);
    expect(document.body.textContent).toContain(
      'El tipo es el del BOE de cada semestre natural',
    );
  });

  it('says that the due date is an estimate', async () => {
    script({
      interest: json(200, { data: interest({ due_date_estimated: true }) }),
    });
    await openInvoice();
    expect(
      screen.getByRole('list', { name: 'Tramos de intereses' }).textContent,
    ).toContain('estimado: 30 días desde la emisión');
  });

  it('says when there are no interests yet', async () => {
    script({
      interest: json(200, {
        data: interest({
          due_date_effective: '2026-11-09',
          interest_cents: 0,
          segments: [],
        }),
      }),
    });
    await openInvoice();
    expect(document.body.textContent).toContain(
      'Todavía no hay intereses: la factura vence el 09/11/2026.',
    );
    expect(screen.queryByRole('table', { name: /tramos/ })).toBeNull();
  });

  it('says when the invoice was paid in full before it fell due', async () => {
    script({
      interest: json(200, {
        data: interest({ segments: [], interest_cents: 0 }),
      }),
    });
    await openInvoice();
    expect(document.body.textContent).toContain(
      'No hay intereses: la factura estaba cobrada por completo cuando venció.',
    );
  });

  it('explains RATE_WINDOW with the missing semesters and says it does not extrapolate', async () => {
    script({
      interest: apiFail(422, 'RATE_WINDOW', {
        missing_semesters: ['2027-H1', '2027-H2'],
      }),
    });
    await openInvoice();
    const text = document.querySelector('.notice')?.textContent ?? '';
    expect(text).toContain('No podemos calcular estos intereses');
    expect(text).toContain(
      'primer semestre de 2027 y segundo semestre de 2027',
    );
    expect(text).toContain('no extrapola ni estima tipos');
    expect(screen.getByText(`No disponible`)).toBeTruthy();
  });

  it('names at most four missing semesters and counts the rest', async () => {
    script({
      interest: apiFail(422, 'RATE_WINDOW', {
        missing_semesters: [
          '2016-H1',
          '2016-H2',
          '2017-H1',
          '2017-H2',
          '2018-H1',
          '2018-H2',
        ],
      }),
    });
    await openInvoice();
    expect(document.querySelector('.notice')?.textContent).toContain(
      'segundo semestre de 2017 y 2 más',
    );
  });

  it('gives a short message for CALCULATION_FAILED', async () => {
    script({ interest: apiError(422, 'CALCULATION_FAILED') });
    await openInvoice();
    expect(document.querySelector('.notice')?.textContent).toBe(
      'No hemos podido calcular los intereses de esta factura. Revisa sus fechas y sus cobros.',
    );
  });

  it('retries the interest alone when the network fails', async () => {
    const { count } = script({
      interest: [networkError, json(200, { data: interest() })],
    });
    const { user } = await openInvoice();
    expect(document.querySelector('.notice')?.textContent).toContain(
      'No hemos podido conectar',
    );
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => {
      expect(
        screen
          .getByRole('list', { name: 'Tramos de intereses' })
          .querySelectorAll('li.seg'),
      ).toHaveLength(4);
    });
    expect(count(INVOICE)).toBe(1);
  });

  it('calculates at another date, shows it and goes back to today', async () => {
    const earlier = interest({
      as_of: '2026-03-31',
      interest_cents: 10_042,
      segments: interest()
        .interest.segments.slice(0, 2)
        .map((s, index) =>
          index === 1 ? { ...s, end: '2026-03-31', days: 90 } : s,
        ),
    });
    const { count, calls } = script({
      extra: { [`${INTEREST}?as_of=2026-03-31`]: json(200, { data: earlier }) },
    });
    const { user } = await openInvoice();
    const input = field('Calcular a otra fecha');
    expect(input.type).toBe('date');
    expect(input.max).toBe(TODAY);
    expect(screen.queryByRole('button', { name: 'Volver a hoy' })).toBeNull();

    fireEvent.change(input, { target: { value: '2026-03-31' } });
    expect(
      await screen.findByRole('heading', {
        name: 'Desglose de intereses a 31/03/2026',
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen
          .getByRole('list', { name: 'Tramos de intereses' })
          .querySelectorAll('li.seg'),
      ).toHaveLength(2);
    });
    expect(calls.some((c) => c.key === `${INTEREST}?as_of=2026-03-31`)).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Volver a hoy' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Desglose de intereses a 19/10/2026',
      }),
    ).toBeTruthy();
    expect(field('Calcular a otra fecha').value).toBe('');
    expect(screen.queryByRole('button', { name: 'Volver a hoy' })).toBeNull();
    // Going back to today asks again: the earlier answer was for another date.
    expect(count(INTEREST)).toBe(2);
  });

  it('does not ask for a future date and says why', async () => {
    const { calls } = script();
    await openInvoice();
    fireEvent.change(field('Calcular a otra fecha'), {
      target: { value: '2999-01-01' },
    });
    expect(
      await screen.findByText('La fecha de cálculo no puede ser futura.', {
        selector: '.field-error',
      }),
    ).toBeTruthy();
    expect(calls.filter((c) => c.key.includes('as_of'))).toHaveLength(0);
    expect(field('Calcular a otra fecha').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });
});

describe('InvoiceDetail: payments', () => {
  it('lists the payments with date and amount', async () => {
    script();
    await openInvoice();
    const table = screen.getByRole('table', {
      name: 'Cobros registrados en esta factura',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toBe(`15/04/2026500,00${NBSP}€`);
  });

  it('says so when there are none', async () => {
    script({ invoice: json(200, { data: detail() }) });
    await openInvoice();
    expect(document.body.textContent).toContain(
      'Todavía no hay cobros registrados.',
    );
  });

  it('records a payment, announces it and redraws the invoice and the Timeline', async () => {
    const after = detail({ paid_cents: 75_050, balance_cents: 109_200 }, [
      payment(),
      payment({ id: 'p-2', paid_on: TODAY, amount_cents: 25_050 }),
    ]);
    const shorter = interest({
      interest_cents: 17_000,
      segments: interest().interest.segments.slice(0, 3),
    });
    const { lastBody, count } = script({
      invoice: [json(200, { data: PAID_ONCE }), json(200, { data: after })],
      interest: [json(200, { data: interest() }), json(200, { data: shorter })],
      extra: {
        [PAY]: json(201, {
          data: { payment: payment(), invoice: after.invoice },
        }),
      },
    });
    const { user } = await openInvoice();
    expect(field('Fecha del cobro').value).toBe(TODAY);
    expect(field('Fecha del cobro').max).toBe(TODAY);

    await user.type(field('Importe cobrado (€)'), '250,50');
    await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));

    expect(await screen.findByText('Cobro registrado.')).toBeTruthy();
    expect(
      screen.getByText('Cobro registrado.').closest('[role=status]'),
    ).toBeTruthy();
    expect(lastBody(PAY)).toEqual({ paid_on: TODAY, amount_cents: 25_050 });
    await waitFor(() => {
      expect(count(INVOICE)).toBe(2);
      expect(count(INTEREST)).toBe(2);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('table', {
          name: 'Cobros registrados en esta factura',
        }),
      ).toBeTruthy();
      expect(
        within(
          screen.getByRole('table', {
            name: 'Cobros registrados en esta factura',
          }),
        ).getAllByRole('row'),
      ).toHaveLength(3);
    });
    expect(document.querySelector('.facts')?.textContent).toContain(
      `1.092,00${NBSP}€`,
    );
    expect(
      screen
        .getByRole('list', { name: 'Tramos de intereses' })
        .querySelectorAll('li.seg'),
    ).toHaveLength(3);
    // The form is ready for the next payment.
    expect(field('Importe cobrado (€)').value).toBe('');
  });

  it.each([
    ['', 'Escribe el importe cobrado.'],
    ['abc', 'Escribe solo números, por ejemplo 1.234,56.'],
    ['0', 'El importe tiene que ser mayor que cero.'],
    ['-5', 'El importe tiene que ser mayor que cero.'],
    ['1,234', 'No sabemos si es una cifra con decimales o con miles.'],
    ['1,234567', 'Usa como máximo dos decimales, por ejemplo 1.234,56.'],
    ['999.999.999,99', 'El importe es demasiado grande.'],
  ])(
    'refuses the amount "%s" without calling the server',
    async (typed, message) => {
      const { count } = script();
      const { user } = await openInvoice();
      if (typed !== '') await user.type(field('Importe cobrado (€)'), typed);
      await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));
      const error = await screen.findByText(
        new RegExp(`^${message.replaceAll('.', '\\.')}`),
        {
          selector: '.field-error',
        },
      );
      expect(error).toBeTruthy();
      const input = field('Importe cobrado (€)');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toContain(error.id);
      expect(count(PAY)).toBe(0);
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    },
  );

  it('asks for a date when it is empty', async () => {
    const { count } = script();
    const { user } = await openInvoice();
    fireEvent.change(field('Fecha del cobro'), { target: { value: '' } });
    await user.type(field('Importe cobrado (€)'), '10');
    await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));
    expect(
      await screen.findByText('Elige la fecha del cobro.', {
        selector: '.field-error',
      }),
    ).toBeTruthy();
    expect(count(PAY)).toBe(0);
  });

  describe.each<[string, number, string, unknown, string, string]>([
    [
      'PAYMENT_EXCEEDS_BALANCE',
      422,
      'PAYMENT_EXCEEDS_BALANCE',
      { remaining_cents: 134_250 },
      'Importe cobrado (€)',
      `Es más de lo que falta por cobrar: quedan 1.342,50${NBSP}€.`,
    ],
    [
      'PAYMENT_IN_FUTURE',
      422,
      'PAYMENT_IN_FUTURE',
      undefined,
      'Fecha del cobro',
      'La fecha del cobro no puede ser futura.',
    ],
    [
      'PAYMENT_BEFORE_ISSUE',
      422,
      'PAYMENT_BEFORE_ISSUE',
      undefined,
      'Fecha del cobro',
      'La fecha del cobro no puede ser anterior a la emisión.',
    ],
  ])('%s', (_name, status, code, details, label, text) => {
    it('shows the Spanish message next to its field', async () => {
      script({ extra: { [PAY]: apiFail(status, code, details) } });
      const { user } = await openInvoice();
      await user.type(field('Importe cobrado (€)'), '100');
      await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));
      const error = await screen.findByText(text.replaceAll(NBSP, ' '), {
        selector: '.field-error',
      });
      expect(field(label).getAttribute('aria-invalid')).toBe('true');
      expect(field(label).getAttribute('aria-describedby')).toContain(error.id);
      await waitFor(() => {
        expect(document.activeElement).toBe(field(label));
      });
      expect(screen.queryByText('Cobro registrado.')).toBeNull();
    });
  });

  it.each([
    [
      409,
      'INVOICE_IN_CLAIM',
      undefined,
      'Esta factura está en una reclamación y ya no admite cambios.',
    ],
    [
      422,
      'PAYMENT_LIMIT_REACHED',
      { limit: 200 },
      'Esta factura ya tiene el máximo de cobros registrados (200).',
    ],
    [500, 'INTERNAL_ERROR', undefined, 'Algo ha fallado de nuestro lado.'],
  ])(
    'shows %s %s as a message for the whole form',
    async (status, code, details, text) => {
      script({ extra: { [PAY]: apiFail(status, code, details) } });
      const { user } = await openInvoice();
      await user.type(field('Importe cobrado (€)'), '100');
      await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));
      const alert = await waitFor(() => {
        const box = document.querySelector('.pay-form [data-error-summary]');
        if (!box?.textContent) throw new Error('empty');
        return box;
      });
      expect(alert.textContent).toContain(text);
      await waitFor(() => {
        expect(document.activeElement).toBe(alert);
      });
    },
  );

  it('on INVOICE_FULLY_PAID says so and asks the invoice again', async () => {
    const paid = detail(
      { status: 'PAID', balance_cents: 0, paid_cents: 184_250, overdue: false },
      [payment({ amount_cents: 184_250 })],
    );
    const { count } = script({
      invoice: [json(200, { data: PAID_ONCE }), json(200, { data: paid })],
      extra: { [PAY]: apiFail(422, 'INVOICE_FULLY_PAID', undefined) },
    });
    const { user } = await openInvoice();
    await user.type(field('Importe cobrado (€)'), '100');
    await user.click(screen.getByRole('button', { name: 'Añadir cobro' }));
    expect(
      await screen.findByText('La factura ya está cobrada por completo.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(count(INVOICE)).toBe(2);
    });
    await waitFor(() => {
      expect(field('Importe cobrado (€)').disabled).toBe(true);
    });
  });

  it('turns the form off, with the reason, when the invoice is paid', async () => {
    script({
      invoice: json(200, {
        data: detail(
          {
            status: 'PAID',
            balance_cents: 0,
            paid_cents: 184_250,
            overdue: false,
          },
          [payment({ amount_cents: 184_250 })],
        ),
      }),
    });
    await openInvoice();
    expect(field('Fecha del cobro').disabled).toBe(true);
    expect(field('Importe cobrado (€)').disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Añadir cobro',
      }).disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'La factura está cobrada por completo: no admite más cobros.',
    );
    expect(document.querySelector('.badge')?.textContent).toBe('Pagada');
  });
});

describe('InvoiceDetail: debtor', () => {
  it('shows the name, the tax id, the four kinds as radio buttons and why it matters', async () => {
    script({
      debtor: json(200, {
        data: { debtor: debtor({ email: 'pagos@example.test' }) },
      }),
    });
    await openInvoice();
    const section = screen.getByRole('region', { name: 'Deudor' });
    expect(section.textContent).toContain('B00000001');
    const group = within(section).getByRole('group', {
      name: 'Tipo de deudor',
    });
    const radios = within(group).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      'Empresa o autónomo (B2B)',
      'Administración pública',
      'Consumidor',
      'Sin clasificar',
    ]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
    expect(field('Email del deudor (opcional)').value).toBe(
      'pagos@example.test',
    );
    expect(section.textContent).toContain(
      'Reclama solo reclama intereses a empresas y autónomos',
    );
    expect(section.textContent).toContain(
      'Un deudor «Sin clasificar» hay que marcarlo como empresa o autónomo antes de reclamar.',
    );
  });

  it('shows "Sin NIF" for a debtor without one', async () => {
    script({
      debtor: json(200, { data: { debtor: debtor({ tax_id: null }) } }),
    });
    await openInvoice();
    expect(
      screen.getByRole('region', { name: 'Deudor' }).textContent,
    ).toContain('Sin NIF');
  });

  it('saves the kind and the lower-cased email, shows the saved state and updates "Crear reclamación"', async () => {
    const { lastBody } = script({
      debtor: [
        json(200, { data: { debtor: debtor({ kind: 'UNKNOWN' }) } }),
        json(200, {
          data: { debtor: debtor({ kind: 'CONSUMER', email: 'a@b.es' }) },
        }),
      ],
      extra: {
        [PATCH_DEBTOR]: json(200, {
          data: { debtor: debtor({ kind: 'CONSUMER', email: 'a@b.es' }) },
        }),
      },
    });
    renderApp(`/facturas/${INVOICE_ID}`);
    await screen.findByRole('radio', { name: 'Sin clasificar' });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(claim().closest('button')?.hasAttribute('disabled')).toBe(true);
    });
    expect(document.body.textContent).toContain(
      'Marca al deudor como empresa o autónomo para poder reclamar.',
    );

    await user.click(screen.getByRole('radio', { name: 'Consumidor' }));
    await user.type(field('Email del deudor (opcional)'), '  A@B.es ');
    await user.click(screen.getByRole('button', { name: 'Guardar deudor' }));

    expect(await screen.findByText('Deudor guardado.')).toBeTruthy();
    expect(lastBody(PATCH_DEBTOR)).toEqual({
      kind: 'CONSUMER',
      email: 'a@b.es',
    });
    expect(field('Email del deudor (opcional)').value).toBe('a@b.es');
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'Reclama no reclama a consumidores: quedan fuera de la ley de morosidad.',
      );
    });
  });

  it('clears the email when the field is emptied', async () => {
    const { lastBody } = script({
      debtor: json(200, { data: { debtor: debtor({ email: 'x@y.es' }) } }),
      extra: { [PATCH_DEBTOR]: json(200, { data: { debtor: debtor() } }) },
    });
    const { user } = await openInvoice();
    await user.clear(field('Email del deudor (opcional)'));
    await user.click(screen.getByRole('button', { name: 'Guardar deudor' }));
    await screen.findByText('Deudor guardado.');
    expect(lastBody(PATCH_DEBTOR)).toEqual({ kind: 'BUSINESS', email: null });
  });

  it('checks the email like the server does, before calling it', async () => {
    const { count } = script();
    const { user } = await openInvoice();
    await user.type(field('Email del deudor (opcional)'), 'no-es-un-email');
    await user.click(screen.getByRole('button', { name: 'Guardar deudor' }));
    const error = await screen.findByText(
      'Escribe un email válido, por ejemplo nombre@empresa.es.',
      {
        selector: '.field-error',
      },
    );
    expect(
      field('Email del deudor (opcional)').getAttribute('aria-describedby'),
    ).toContain(error.id);
    expect(count(PATCH_DEBTOR)).toBe(0);
    expect(screen.queryByText('Deudor guardado.')).toBeNull();
  });

  it('shows the API field error for the email in Spanish', async () => {
    script({
      extra: {
        [PATCH_DEBTOR]: apiError(400, 'VALIDATION_ERROR', [
          { path: 'email', message: 'Must be a valid email address' },
        ]),
      },
    });
    const { user } = await openInvoice();
    await user.type(field('Email del deudor (opcional)'), 'ok@example.test');
    await user.click(screen.getByRole('button', { name: 'Guardar deudor' }));
    expect(
      await screen.findByText(
        'Escribe un email válido, por ejemplo nombre@empresa.es.',
        {
          selector: '.field-error',
        },
      ),
    ).toBeTruthy();
    expect(
      field('Email del deudor (opcional)').getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('shows a server error as a message for the whole form and keeps what was typed', async () => {
    script({ extra: { [PATCH_DEBTOR]: apiError(500, 'INTERNAL_ERROR') } });
    const { user } = await openInvoice();
    await user.click(screen.getByRole('radio', { name: 'Consumidor' }));
    await user.click(screen.getByRole('button', { name: 'Guardar deudor' }));
    await waitFor(() => {
      expect(
        document.querySelector('form [data-error-summary]:not(:empty)')
          ?.textContent,
      ).toContain('Algo ha fallado de nuestro lado.');
    });
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Consumidor' })
        .checked,
    ).toBe(true);
    expect(screen.queryByText('Deudor guardado.')).toBeNull();
  });

  it('can retry when the debtor cannot be loaded, and the rest of the page still works', async () => {
    script({
      debtor: [networkError, json(200, { data: { debtor: debtor() } })],
    });
    renderApp(`/facturas/${INVOICE_ID}`);
    await screen.findByRole('heading', {
      level: 1,
      name: 'Factura FA-2025-001',
    });
    const section = await screen.findByRole('region', { name: 'Deudor' });
    await waitFor(() => {
      expect(
        within(section).getByRole('button', { name: 'Reintentar' }),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole('table', { name: 'Cobros registrados en esta factura' }),
    ).toBeTruthy();
    await userEvent
      .setup()
      .click(within(section).getByRole('button', { name: 'Reintentar' }));
    expect(
      await screen.findByRole('radio', { name: 'Sin clasificar' }),
    ).toBeTruthy();
  });
});

describe('InvoiceDetail: "Crear reclamación"', () => {
  it('is a link to the claim screen for this debtor when the debtor is a business and the invoice is overdue', async () => {
    script();
    await openInvoice();
    const link = screen.getByRole('link', { name: 'Crear reclamación' });
    expect(link.getAttribute('href')).toBe(
      `/reclamaciones/nueva?deudor=${DEBTOR_ID}`,
    );
    expect(link.className).toContain('primary');
    expect(document.getElementById('claim-reason')).toBeNull();
  });

  it('opens the claim screen (not built yet, but behind the same login)', async () => {
    script();
    const { router, user } = await openInvoice();
    await user.click(screen.getByRole('link', { name: 'Crear reclamación' }));
    expect(router.state.location.pathname).toBe('/reclamaciones/nueva');
    expect(router.state.location.search).toBe(`?deudor=${DEBTOR_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Próximamente' }),
    ).toBeTruthy();
  });

  it.each([
    ['UNKNOWN', 'Marca al deudor como empresa o autónomo para poder reclamar.'],
    [
      'CONSUMER',
      'Reclama no reclama a consumidores: quedan fuera de la ley de morosidad.',
    ],
    [
      'PUBLIC_ADMIN',
      'Reclama no tramita reclamaciones a administraciones públicas.',
    ],
  ] as const)(
    'is disabled with the reason when the debtor is %s',
    async (kind, reason) => {
      script({ debtor: json(200, { data: { debtor: debtor({ kind }) } }) });
      await openInvoice();
      const button = screen.getByRole('button', { name: 'Crear reclamación' });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(
        screen.queryByRole('link', { name: 'Crear reclamación' }),
      ).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBe('claim-reason');
      expect(document.getElementById('claim-reason')?.textContent).toBe(reason);
    },
  );

  it('is disabled when the invoice is not overdue', async () => {
    script({
      invoice: json(200, { data: detail({ overdue: false, days_overdue: 0 }) }),
    });
    await openInvoice();
    expect(
      screen
        .getByRole('button', { name: 'Crear reclamación' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(document.getElementById('claim-reason')?.textContent).toBe(
      'La factura todavía no ha vencido.',
    );
  });

  it('is disabled when the invoice is paid', async () => {
    script({
      invoice: json(200, {
        data: detail(
          {
            status: 'PAID',
            overdue: false,
            balance_cents: 0,
            paid_cents: 184_250,
          },
          [payment({ amount_cents: 184_250 })],
        ),
      }),
    });
    await openInvoice();
    expect(document.getElementById('claim-reason')?.textContent).toBe(
      'La factura está cobrada por completo: no hay nada que reclamar.',
    );
  });
});

describe('InvoiceDetail: accessibility', () => {
  it('names every field and button, and every table has a caption and header scopes', async () => {
    script();
    await openInvoice();
    for (const input of document.querySelectorAll('main input')) {
      const labels = (input as HTMLInputElement).labels;
      expect(
        labels?.length,
        `input ${(input as HTMLInputElement).name || (input as HTMLInputElement).type}`,
      ).toBeGreaterThan(0);
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent.trim().length).toBeGreaterThan(0);
    }
    for (const table of screen.getAllByRole('table')) {
      expect(table.querySelector('caption')?.textContent).toBeTruthy();
      for (const header of table.querySelectorAll('th')) {
        expect(['col', 'row']).toContain(header.getAttribute('scope'));
      }
    }
    // One level-one heading, then sections with their own headings.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual(['Desglose de intereses a 19/10/2026', 'Cobros', 'Deudor']);
  });

  it('moves focus to the main area when the invoice is opened from the list', async () => {
    script({
      extra: {
        'GET /api/invoices': json(200, {
          data: {
            invoices: [detail().invoice],
            totals: {
              count: 1,
              outstanding_cents: 0,
              interest_cents: 0,
              overdue_count: 1,
              interest_unavailable_count: 0,
              truncated: false,
            },
            page: { limit: 50, offset: 0, total: 1 },
          },
        }),
        'GET /api/debtors?limit=100&offset=0': json(200, {
          data: {
            debtors: [debtor()],
            page: { limit: 100, offset: 0, total: 1 },
          },
        }),
      },
    });
    const router = renderApp('/panel');
    const link = await screen.findByRole('link', {
      name: 'Ver desglose de la factura FA-2025-001',
    });
    await userEvent.setup().click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/facturas/${INVOICE_ID}`);
    });
    await screen.findByRole('heading', {
      level: 1,
      name: 'Factura FA-2025-001',
    });
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
