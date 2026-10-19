// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatEUR } from '../lib/format.ts';
import { CLAIM_ID, claimDetail, claimsPage } from '../test/fixtures.ts';
import {
  apiError,
  deferred,
  empty,
  html,
  json,
  me,
  mockApi,
  networkError,
  type Reply,
} from '../test/mock-api.ts';
import { renderApp } from '../test/render.tsx';

// The layout keeps an empty live region (role alert) of its own: the page's alerts live in <main>.
const inMain = () => within(screen.getByRole('main'));

const DETAIL = `GET /api/claims/${CLAIM_ID}`;
const LETTER = `GET /api/claims/${CLAIM_ID}/letter.pdf`;
const CANCEL = `DELETE /api/claims/${CLAIM_ID}`;
const PATH = `/reclamaciones/${CLAIM_ID}`;

const pdf = (disposition = 'attachment; filename="requerimiento-demo.pdf"') =>
  (() =>
    new Response(new Blob(['%PDF-1.4 test']), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': disposition,
      },
    })) satisfies Reply;

function script(extra: Record<string, Reply | Reply[]> = {}) {
  return mockApi({
    'GET /api/me': me(),
    [DETAIL]: json(200, { data: claimDetail() }),
    ...extra,
  });
}

// jsdom neither creates object URLs nor follows a link: the download is observed through them.
let clicked: { download: string; href: string }[];
beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ download: this.download, href: this.href });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ClaimDetailPage', () => {
  it('shows a skeleton while the claim loads', async () => {
    const gate = deferred(json(200, { data: claimDetail() }));
    script({ [DETAIL]: gate.reply });
    renderApp(PATH);
    expect(await screen.findByText('Cargando la reclamación…')).toBeTruthy();
    gate.release();
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Reclamación a Talleres Ejemplo S.L.',
      }),
    ).toBeTruthy();
  });

  it('shows the frozen figures: principal, interest, compensation and total', async () => {
    script();
    renderApp(PATH);
    await screen.findByRole('heading', { level: 1 });
    const facts = document.querySelector('dl.facts') as HTMLElement;
    expect(facts.textContent).toContain(formatEUR(234_250));
    expect(facts.textContent).toContain(formatEUR(25_000));
    expect(facts.textContent).toContain(formatEUR(4000));
    expect(facts.textContent).toContain(formatEUR(263_250));
    expect(facts.textContent).toContain('2 facturas');
    expect(facts.textContent).toContain('40 € por reclamación');
  });

  it('lists each invoice with its amounts and its interest segments', async () => {
    script();
    renderApp(PATH);
    const table = await screen.findByRole('table', {
      name: /Facturas de la reclamación/,
    });
    const rows = within(table).getAllByRole('row');
    // header + two invoices
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1] as HTMLElement).getByText('FA-2025-001'),
    ).toBeTruthy();
    expect(
      within(rows[2] as HTMLElement).getByText('FA-2025-002'),
    ).toBeTruthy();
    expect(
      screen.getByText('Tramos de interés de la factura FA-2025-001'),
    ).toBeTruthy();
    expect(
      screen.getByText('Tramos de interés de la factura FA-2025-002'),
    ).toBeTruthy();
  });

  it('says the claim does not exist on a 404, with a way back', async () => {
    script({ [DETAIL]: apiError(404, 'NOT_FOUND') });
    renderApp(PATH);
    expect(
      await screen.findByRole('heading', {
        name: 'No encontramos esta reclamación',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Ver todas las reclamaciones/ })
        .getAttribute('href'),
    ).toBe('/reclamaciones');
  });

  it('offers to retry when the claim cannot be loaded, and recovers', async () => {
    script({ [DETAIL]: [networkError, json(200, { data: claimDetail() })] });
    renderApp(PATH);
    const user = userEvent.setup();
    expect(await screen.findByText(/No hemos podido conectar/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Reclamación a/ }),
    ).toBeTruthy();
  });

  describe('letter download', () => {
    it('downloads the PDF under the name the server gives, and confirms', async () => {
      const api = script({ [LETTER]: pdf() });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      expect(
        await screen.findByText(/Carta descargada: la tienes en tu carpeta/),
      ).toBeTruthy();
      expect(api.count(LETTER)).toBe(1);
      expect(clicked).toEqual([
        { download: 'requerimiento-demo.pdf', href: 'blob:test' },
      ]);
      expect(inMain().queryByRole('alert')).toBeNull();
    });

    it('falls back to its own file name when the header is not a plain name', async () => {
      script({ [LETTER]: pdf('attachment; filename="../../etc/passwd"') });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      await screen.findByText(/Carta descargada/);
      expect(clicked[0]?.download).toBe('requerimiento.pdf');
    });

    it('disables the button while the letter is prepared, then gives the focus back', async () => {
      const gate = deferred(pdf());
      script({ [LETTER]: gate.reply });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      const busy = await screen.findByRole('button', { name: 'Preparando…' });
      expect(busy.hasAttribute('disabled')).toBe(true);
      gate.release();
      const button = await screen.findByRole('button', {
        name: 'Descargar carta (PDF)',
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(button);
      });
    });

    it('names the missing profile fields and links to the profile', async () => {
      script({
        [LETTER]: apiError(422, 'PROFILE_INCOMPLETE', [
          { path: 'tax_id', message: 'x' },
          { path: 'iban', message: 'x' },
        ]),
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      const alert = await inMain().findByRole('alert');
      expect(alert.textContent).toContain(
        'faltan datos en tu perfil: NIF/CIF, IBAN válido.',
      );
      expect(
        within(alert)
          .getByRole('link', { name: 'Completar el perfil' })
          .getAttribute('href'),
      ).toBe('/perfil');
      expect(clicked).toHaveLength(0);
    });

    it('explains that an invoice changed and suggests cancelling', async () => {
      script({
        [LETTER]: json(422, {
          error: {
            code: 'CLAIM_NOT_ACTIONABLE',
            message: 'x',
            request_id: 'r',
            details: { reason: 'invoice_changed' },
          },
        }),
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'Una de las facturas ha cambiado',
      );
      expect(clicked).toHaveLength(0);
    });

    it('does not save an HTML page that answers 200 as if it were the PDF', async () => {
      script({ [LETTER]: html(200) });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
      );
      expect(await inMain().findByRole('alert')).toBeTruthy();
      expect(clicked).toHaveLength(0);
      expect(screen.queryByText(/Carta descargada/)).toBeNull();
    });

    it('says the connection failed and lets the person try again', async () => {
      const api = script({ [LETTER]: [networkError, pdf()] });
      renderApp(PATH);
      const user = userEvent.setup();
      const download = async () => {
        await user.click(
          await screen.findByRole('button', { name: 'Descargar carta (PDF)' }),
        );
      };
      await download();
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'No hemos podido conectar',
      );
      await download();
      await screen.findByText(/Carta descargada/);
      expect(inMain().queryByRole('alert')).toBeNull();
      expect(api.count(LETTER)).toBe(2);
    });
  });

  describe('cancelling the claim', () => {
    const openConfirmation = async (
      user: ReturnType<typeof userEvent.setup>,
    ) => {
      await user.click(
        await screen.findByRole('button', { name: 'Cancelar reclamación' }),
      );
    };

    it('asks first, warns that a sent letter is not undone, and puts the focus on the safe choice', async () => {
      const api = script();
      renderApp(PATH);
      const user = userEvent.setup();
      await openConfirmation(user);
      const group = screen.getByRole('group', {
        name: '¿Cancelar esta reclamación?',
      });
      expect(group.textContent).toContain('cancelar no lo deshace');
      await waitFor(() => {
        expect(document.activeElement).toBe(
          within(group).getByRole('button', { name: 'No, mantenerla' }),
        );
      });
      expect(api.count(CANCEL)).toBe(0);
    });

    it('keeps the claim and returns the focus to the opening button', async () => {
      const api = script();
      renderApp(PATH);
      const user = userEvent.setup();
      await openConfirmation(user);
      await user.click(screen.getByRole('button', { name: 'No, mantenerla' }));
      const opener = await screen.findByRole('button', {
        name: 'Cancelar reclamación',
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(opener);
      });
      expect(api.count(CANCEL)).toBe(0);
    });

    it('deletes the claim and goes to the list saying it was cancelled', async () => {
      const api = script({
        [CANCEL]: empty(204),
        'GET /api/claims': json(200, claimsPage([])),
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await openConfirmation(user);
      await user.click(
        screen.getByRole('button', { name: 'Sí, cancelar la reclamación' }),
      );
      expect(await screen.findByText('Reclamación cancelada.')).toBeTruthy();
      expect(api.count(CANCEL)).toBe(1);
    });

    it('treats a claim that is already gone as cancelled', async () => {
      script({
        [CANCEL]: apiError(404, 'NOT_FOUND'),
        'GET /api/claims': json(200, claimsPage([])),
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await openConfirmation(user);
      await user.click(
        screen.getByRole('button', { name: 'Sí, cancelar la reclamación' }),
      );
      expect(await screen.findByText('Reclamación cancelada.')).toBeTruthy();
    });

    it('stays on the claim and says what went wrong when the server fails', async () => {
      const api = script({ [CANCEL]: apiError(500, 'INTERNAL') });
      renderApp(PATH);
      const user = userEvent.setup();
      await openConfirmation(user);
      await user.click(
        screen.getByRole('button', { name: 'Sí, cancelar la reclamación' }),
      );
      const alert = await inMain().findByRole('alert');
      await waitFor(() => {
        expect(document.activeElement).toBe(alert);
      });
      expect(
        screen.getByRole('heading', { level: 1, name: /Reclamación a/ }),
      ).toBeTruthy();
      expect(api.count(CANCEL)).toBe(1);
    });
  });
});
