// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  deferred,
  json,
  me,
  mockApi,
  networkError,
} from '../test/mock-api.ts';
import {
  dayFromToday,
  debtor,
  debtorsPage,
  invoice,
  invoicesPage,
} from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const NBSP = ' ';
const DEBTORS = 'GET /api/debtors?limit=100&offset=0';

const other = debtor({
  id: 'd2',
  name: 'Panadería Ficticia S.L.',
  tax_id: null,
});
const LATE = invoice({ id: 'i-late', number: 'FA-1' });
const SOON = invoice({
  id: 'i-soon',
  number: 'FA-2',
  debtor_id: 'd2',
  overdue: false,
  days_overdue: 0,
  due_date: dayFromToday(17),
  due_date_effective: dayFromToday(17),
  amount_cents: 56_400,
  balance_cents: 56_400,
  interest_cents: 0,
});
const PARTIAL = invoice({
  id: 'i-part',
  number: 'FA-3',
  days_overdue: 100,
  paid_cents: 40_000,
  balance_cents: 60_000,
  amount_cents: 100_000,
});
const PAID = invoice({
  id: 'i-paid',
  number: 'FA-4',
  status: 'PAID',
  overdue: false,
  days_overdue: 0,
  balance_cents: 0,
  paid_cents: 184_250,
  interest_cents: 1200,
});
const DISPUTED = invoice({ id: 'i-disp', number: 'FA-5', status: 'DISPUTED' });

async function openDashboard(path = '/panel') {
  const router = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Facturas' });
  // The heading is drawn at once; wait until the skeleton has given way to the answer.
  await waitFor(() => {
    expect(screen.queryByText('Cargando facturas…')).toBeNull();
  });
  return { router, user: userEvent.setup() };
}

const errorBox = () => {
  const box = document.querySelector('.state.error');
  if (!box) throw new Error('no error box');
  return box;
};
const rows = () =>
  within(screen.getByRole('table')).getAllByRole('row').slice(1);
const rowNumbers = () =>
  rows().map((row) => within(row).getByRole('rowheader').textContent);

function signedIn(
  invoices: Parameters<typeof invoicesPage>[0],
  options: Parameters<typeof invoicesPage>[1] = {},
  extra: Parameters<typeof mockApi>[0] = {},
) {
  return mockApi({
    'GET /api/me': me(),
    'GET /api/invoices': json(200, invoicesPage(invoices, options)),
    [DEBTORS]: json(200, debtorsPage([debtor(), other])),
    ...extra,
  });
}

describe('Dashboard: loading and success', () => {
  it('announces the loading state with a status and a skeleton, then shows the list', async () => {
    const gate = deferred(json(200, invoicesPage([LATE])));
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': gate.reply,
      [DEBTORS]: json(200, debtorsPage([debtor()])),
    });
    renderApp('/panel');
    const status = (await screen.findByText('Cargando facturas…')).closest(
      '[role="status"]',
    );
    if (!status) throw new Error('no status');
    expect(status.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    gate.release();
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByText('Cargando facturas…')).toBeNull();
  });

  it('shows the three summary figures from the API totals', async () => {
    signedIn([LATE, SOON], {
      totals: {
        outstanding_cents: 1_854_465,
        interest_cents: 71_463,
        overdue_count: 11,
      },
    });
    await openDashboard();
    const summary = screen.getByRole('region', { name: 'Resumen' });
    const text = summary.textContent;
    expect(text).toContain(`18.544,65${NBSP}€`);
    expect(text).toContain(`714,63${NBSP}€`);
    expect(within(summary).getByText('11')).toBeTruthy();
    expect(text).toContain('Pendiente de cobro');
    expect(text).toContain('Intereses de demora');
    expect(text).toContain('Facturas vencidas');
    expect(text).toContain('Solo suma las facturas cuyos intereses se han');
    expect(text).not.toContain('no se han podido calcular');
  });

  it('says how many invoices are left out of the interest total, and when the totals are cut', async () => {
    signedIn([LATE], {
      totals: { interest_unavailable_count: 2, truncated: true },
    });
    await openDashboard();
    const text = screen.getByRole('region', { name: 'Resumen' }).textContent;
    expect(text).toContain(
      'En 2 facturas no se han podido calcular y no están en esta suma.',
    );
    expect(text).toContain('solo incluyen las primeras 2000 facturas');
  });

  it('uses the singular for one invoice without interest', async () => {
    signedIn([LATE], { totals: { interest_unavailable_count: 1 } });
    await openDashboard();
    expect(document.body.textContent).toContain(
      'En 1 factura no se han podido calcular',
    );
  });

  it('lists the invoices in the order the API gives, with debtor, due date, state, balance and interest', async () => {
    signedIn([LATE, SOON, PAID, DISPUTED, PARTIAL]);
    await openDashboard();
    expect(rowNumbers()).toEqual(['FA-1', 'FA-2', 'FA-4', 'FA-5', 'FA-3']);

    const [late, soon, paid, disputed] = rows();
    if (!late || !soon || !paid || !disputed) throw new Error('rows');
    expect(late.textContent).toContain('Talleres Ejemplo S.L.');
    expect(late.textContent).toContain('398 días de retraso');
    expect(late.textContent).toContain('Vencida');
    expect(late.textContent).toContain(`1.842,50${NBSP}€`);
    expect(late.textContent).toContain(`205,32${NBSP}€`);

    expect(soon.textContent).toContain('Panadería Ficticia S.L.');
    expect(soon.textContent).toContain('vence en 17 días');
    expect(soon.textContent).toContain('Por vencer');

    expect(paid.textContent).toContain('Pagada');
    expect(paid.textContent).not.toContain('retraso');
    expect(disputed.textContent).toContain('En disputa');
  });

  it('shows "No calculables" for an invoice whose interest could not be worked out', async () => {
    signedIn([
      invoice({ interest_cents: null, interest_error: 'RATE_WINDOW' }),
    ]);
    await openDashboard();
    expect(rows()[0]?.textContent).toContain('No calculables');
  });

  it('marks a due date that is only an estimate', async () => {
    signedIn([invoice({ due_date: null, due_date_estimated: true })]);
    await openDashboard();
    expect(rows()[0]?.textContent).toContain('vencimiento estimado');
  });

  it('links each row to its breakdown with a name that tells the invoice apart', async () => {
    signedIn([LATE, SOON]);
    const { router } = await openDashboard();
    const link = screen.getByRole('link', {
      name: 'Ver desglose de la factura FA-2',
    });
    expect(link.getAttribute('href')).toBe('/facturas/i-soon');
    expect(link.textContent).toBe('Ver desglose');
    expect(router.state.location.pathname).toBe('/panel');
  });
});

describe('Dashboard: the table is also a set of stacked cards', () => {
  it('has a caption, column headers with scope, row headers and a label on every cell', async () => {
    signedIn([LATE, SOON]);
    await openDashboard();
    const table = screen.getByRole('table');
    expect(
      within(table).getByText('Facturas', { selector: 'caption' }),
    ).toBeTruthy();
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Factura',
      'Deudor',
      'Vencimiento',
      'Estado',
      'Pendiente',
      'Intereses',
      'Acciones',
    ]);
    for (const header of headers)
      expect(header.getAttribute('scope')).toBe('col');

    for (const row of rows()) {
      expect(within(row).getByRole('rowheader').getAttribute('scope')).toBe(
        'row',
      );
      const labels = [...row.querySelectorAll('td[data-label]')].map((cell) =>
        cell.getAttribute('data-label'),
      );
      expect(labels).toEqual([
        'Deudor',
        'Vencimiento',
        'Estado',
        'Pendiente',
        'Intereses',
      ]);
    }
  });

  it('gives each state a text and an icon, never colour alone', async () => {
    signedIn([LATE, SOON, PAID, DISPUTED]);
    await openDashboard();
    const badges = [...document.querySelectorAll('.badge')];
    expect(badges.map((b) => b.textContent)).toEqual([
      'Vencida',
      'Por vencer',
      'Pagada',
      'En disputa',
    ]);
    for (const badge of badges) {
      const icon = badge.querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.querySelector('path')?.getAttribute('d')).toBeTruthy();
    }
  });
});

describe('Dashboard: filters', () => {
  it('is a group of toggle buttons, with "Todas" pressed to start', async () => {
    signedIn([LATE, SOON]);
    await openDashboard();
    const group = screen.getByRole('group', { name: 'Filtrar facturas' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Todas',
      'Vencidas',
      'No vencidas',
      'Cobro parcial',
    ]);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
  });

  it('filters the invoices of the page without asking the API again, and keeps the filter in the URL', async () => {
    const { count } = signedIn([LATE, SOON, PARTIAL, PAID]);
    const { user, router } = await openDashboard();
    const press = (name: string) =>
      user.click(screen.getByRole('button', { name }));

    await press('Vencidas');
    expect(rowNumbers()).toEqual(['FA-1', 'FA-3']);
    expect(
      screen
        .getByRole('button', { name: 'Vencidas' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'Todas' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(router.state.location.search).toBe('?filtro=vencidas');
    expect(screen.getByRole('status').textContent).toBe(
      '2 de las 4 facturas de esta página.',
    );

    await press('No vencidas');
    expect(rowNumbers()).toEqual(['FA-2']);
    await press('Cobro parcial');
    expect(rowNumbers()).toEqual(['FA-3']);
    await press('Todas');
    expect(rowNumbers()).toEqual(['FA-1', 'FA-2', 'FA-3', 'FA-4']);
    expect(router.state.location.search).toBe('');
    expect(count('GET /api/invoices')).toBe(1);
  });

  it('starts from the filter in the URL', async () => {
    signedIn([LATE, SOON]);
    await openDashboard('/panel?filtro=no-vencidas');
    expect(rowNumbers()).toEqual(['FA-2']);
    expect(
      screen
        .getByRole('button', { name: 'No vencidas' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('shows the filtered-empty state with a way out', async () => {
    signedIn([LATE, PARTIAL]);
    const { user } = await openDashboard();
    await user.click(screen.getByRole('button', { name: 'No vencidas' }));
    expect(
      screen.getByRole('heading', {
        name: 'Ninguna factura coincide con el filtro',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Quitar filtro' }));
    expect(rowNumbers()).toEqual(['FA-1', 'FA-3']);
  });

  it('warns that the filter only looks at the loaded page when there are more pages', async () => {
    signedIn([LATE], { total: 120, limit: 1 });
    const { user } = await openDashboard();
    await user.click(screen.getByRole('button', { name: 'No vencidas' }));
    expect(document.body.textContent).toContain(
      'Solo hemos mirado las facturas de esta página',
    );
  });
});

describe('Dashboard: paging', () => {
  it('goes to the next page with the offset the API understands, and back', async () => {
    const page2 = invoice({ id: 'i-3', number: 'FA-9' });
    const { count } = signedIn(
      [LATE, SOON],
      { total: 3, limit: 2 },
      {
        'GET /api/invoices?offset=2': json(
          200,
          invoicesPage([page2], { total: 3, limit: 2, offset: 2 }),
        ),
      },
    );
    const { user, router } = await openDashboard();
    expect(screen.getByRole('status').textContent).toBe('Facturas 1 a 2 de 3.');
    const nav = screen.getByRole('navigation', { name: 'Páginas de facturas' });
    const previous = within(nav).getByRole('button', { name: 'Anterior' });
    const next = within(nav).getByRole('button', { name: 'Siguiente' });
    expect(previous.hasAttribute('disabled')).toBe(true);
    expect(next.hasAttribute('disabled')).toBe(false);

    await user.click(next);
    await waitFor(() => {
      expect(rowNumbers()).toEqual(['FA-9']);
    });
    expect(router.state.location.search).toBe('?desde=2');
    expect(screen.getByRole('status').textContent).toBe('Facturas 3 a 3 de 3.');
    // The list is drawn anew while a page loads: look the paging up again.
    const again = screen.getByRole('navigation', {
      name: 'Páginas de facturas',
    });
    expect(
      within(again)
        .getByRole('button', { name: 'Siguiente' })
        .hasAttribute('disabled'),
    ).toBe(true);

    await user.click(within(again).getByRole('button', { name: 'Anterior' }));
    await waitFor(() => {
      expect(rowNumbers()).toEqual(['FA-1', 'FA-2']);
    });
    expect(count('GET /api/invoices?offset=2')).toBe(1);
  });

  it('shows no paging when everything fits in one page', async () => {
    signedIn([LATE]);
    await openDashboard();
    expect(
      screen.queryByRole('navigation', { name: 'Páginas de facturas' }),
    ).toBeNull();
  });

  it('reads all the pages of debtors to find the names', async () => {
    const second = debtor({ id: 'd3', name: 'Logística Prueba S.L.' });
    signedIn(
      [invoice({ debtor_id: 'd3' })],
      {},
      {
        [DEBTORS]: json(200, {
          data: {
            debtors: [debtor()],
            page: { limit: 1, offset: 0, total: 2 },
          },
        }),
        'GET /api/debtors?limit=100&offset=1': json(200, {
          data: {
            debtors: [second],
            page: { limit: 1, offset: 1, total: 2 },
          },
        }),
      },
    );
    await openDashboard();
    expect(rows()[0]?.textContent).toContain('Logística Prueba S.L.');
  });
});

describe('Dashboard: empty and failing', () => {
  it('shows the empty state with the staircase and the way to import', async () => {
    signedIn([], { total: 0 });
    await openDashboard();
    expect(
      screen.getByRole('heading', { name: 'Aún no tienes facturas' }),
    ).toBeTruthy();
    expect(
      document.querySelector('.stair-mark')?.getAttribute('aria-hidden'),
    ).toBe('true');
    const link = screen.getByRole('link', { name: 'Importar CSV' });
    expect(link.getAttribute('href')).toBe('/importar');
    expect(document.body.textContent).toContain('La demo de la portada');
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.queryByRole('group', { name: 'Filtrar facturas' }),
    ).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resumen' })).toBeNull();
  });

  it('shows an error with "Reintentar" and recovers on the second try', async () => {
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': [networkError, json(200, invoicesPage([LATE]))],
      [DEBTORS]: json(200, debtorsPage([debtor()])),
    });
    const { user } = await openDashboard();
    const alert = errorBox();
    expect(alert.textContent).toContain('No hemos podido cargar las facturas');
    expect(alert.textContent).toContain('No hemos podido conectar');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(document.querySelector('.state.error')).toBeNull();
  });

  it('shows the error when the debtors cannot be read', async () => {
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': json(200, invoicesPage([LATE])),
      [DEBTORS]: apiError(500, 'INTERNAL_ERROR'),
    });
    await openDashboard();
    expect(errorBox().textContent).toContain('Algo ha fallado de nuestro lado');
  });

  it('tells a rate-limited person how long to wait', async () => {
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': apiError(429, 'RATE_LIMITED', undefined, {
        'Retry-After': '30',
      }),
      [DEBTORS]: json(200, debtorsPage([debtor()])),
    });
    await openDashboard();
    expect(errorBox().textContent).toContain('Espera 30 segundos');
  });

  it('sends the person to the login when the session is gone', async () => {
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': apiError(401, 'UNAUTHENTICATED'),
      [DEBTORS]: apiError(401, 'UNAUTHENTICATED'),
    });
    const router = renderApp('/panel');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
  });
});

describe('Dashboard: page', () => {
  it('sets the title, marks "Facturas" in the menu and says the calculation day', async () => {
    signedIn([LATE]);
    await openDashboard();
    expect(document.title).toBe('Facturas · Reclama');
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(
      within(nav)
        .getByRole('link', { name: 'Facturas' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(document.body.textContent).toMatch(
      /Intereses calculados a \d{2}\/\d{2}\/\d{4}/,
    );
  });
});
