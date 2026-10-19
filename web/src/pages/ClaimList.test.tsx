// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { formatEUR } from '../lib/format.ts';
import { CLAIM_ID, claimSummary, claimsPage } from '../test/fixtures.ts';
import {
  deferred,
  json,
  me,
  mockApi,
  networkError,
  type Reply,
} from '../test/mock-api.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

// getByText collapses the non-breaking space of an amount, so the expected text must too.
const eur = (cents: number) => formatEUR(cents).replace(/\u00a0/g, ' ');

const LIST = 'GET /api/claims';

function script(
  claims: Reply | Reply[],
  extra: Record<string, Reply | Reply[]> = {},
) {
  return mockApi({ 'GET /api/me': me(), [LIST]: claims, ...extra });
}

describe('ClaimList', () => {
  it('shows a skeleton while the claims load', async () => {
    const gate = deferred(json(200, claimsPage([claimSummary()])));
    script(gate.reply);
    renderApp('/reclamaciones');
    expect(await screen.findByText('Cargando las reclamaciones…')).toBeTruthy();
    gate.release();
    await screen.findByRole('table');
  });

  it('says there is nothing yet and points to the invoices', async () => {
    script(json(200, claimsPage([])));
    renderApp('/reclamaciones');
    expect(
      await screen.findByRole('heading', {
        name: 'Aún no has creado ninguna reclamación',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Ver las facturas' })
        .getAttribute('href'),
    ).toBe('/panel');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers to retry when the claims cannot be loaded, and recovers', async () => {
    script([networkError, json(200, claimsPage([claimSummary()]))]);
    renderApp('/reclamaciones');
    const user = userEvent.setup();
    expect(await screen.findByText(/No hemos podido conectar/)).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Reclamaciones' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('lists each claim with its debtor, date, state, invoices and total', async () => {
    script(
      json(
        200,
        claimsPage([
          claimSummary({
            last_event: { kind: 'DEMAND_SENT', occurred_on: '2026-10-20' },
          }),
          claimSummary({
            id: 'a1',
            debtor_name: 'Pinturas Demo S.A.',
            next_action: { action: 'DONE', earliest_on: null },
            total_cents: 15_000,
            invoice_count: 1,
          }),
          claimSummary({
            id: 'a2',
            debtor_name: 'Bloqueada S.L.',
            next_action: { action: 'BLOCKED', earliest_on: null },
          }),
        ]),
      ),
    );
    renderApp('/reclamaciones');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole('rowheader').textContent).toBe(
      'Talleres Ejemplo S.L.',
    );
    expect(first.getByText('19/10/2026')).toBeTruthy();
    expect(first.getByText('En curso')).toBeTruthy();
    expect(first.getByText('Requerimiento enviado el 20/10/2026')).toBeTruthy();
    expect(first.getByText(eur(263_250))).toBeTruthy();
    expect(
      first
        .getByRole('link', {
          name: 'Ver la reclamación a Talleres Ejemplo S.L.',
        })
        .getAttribute('href'),
    ).toBe(`/reclamaciones/${CLAIM_ID}`);

    expect(within(rows[1] as HTMLElement).getByText('Cobrada')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(eur(15_000))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Bloqueada')).toBeTruthy();
    expect(screen.getByText(/Reclamaciones 1 a 3 de 3\./)).toBeTruthy();
    expect(
      screen.queryByRole('navigation', { name: 'Páginas de reclamaciones' }),
    ).toBeNull();
  });

  it('pages through the claims', async () => {
    const api = script(
      json(200, claimsPage([claimSummary()], { total: 120 })),
      {
        'GET /api/claims?offset=50': json(
          200,
          claimsPage([claimSummary({ debtor_name: 'Segunda Página S.L.' })], {
            total: 120,
            offset: 50,
          }),
        ),
      },
    );
    renderApp('/reclamaciones');
    const user = userEvent.setup();
    const pager = await screen.findByRole('navigation', {
      name: 'Páginas de reclamaciones',
    });
    expect(
      within(pager)
        .getByRole('button', { name: 'Anterior' })
        .hasAttribute('disabled'),
    ).toBe(true);
    await user.click(within(pager).getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Segunda Página S.L.')).toBeTruthy();
    expect(api.count('GET /api/claims?offset=50')).toBe(1);
    expect(screen.getByText(/Reclamaciones 51 a 51 de 120\./)).toBeTruthy();
  });

  it('says so when the page asked for is past the end, and goes back', async () => {
    script(json(200, claimsPage([claimSummary()], { total: 3 })), {
      'GET /api/claims?offset=50': json(
        200,
        claimsPage([], { total: 3, offset: 50 }),
      ),
    });
    renderApp('/reclamaciones?desde=50');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'Esta página ya no existe' }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Volver al principio' }),
    );
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('says a claim was cancelled when it comes from a cancellation', async () => {
    script(json(200, claimsPage([])));
    renderApp('/reclamaciones', { cancelled: true });
    expect(await screen.findByText('Reclamación cancelada.')).toBeTruthy();
  });
});
