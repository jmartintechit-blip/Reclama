// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimDetail } from '../lib/api-types.ts';
import { formatDate, formatEUR } from '../lib/format.ts';
import {
  CLAIM_ID,
  claimDetail,
  claimEvent,
  claimsPage,
  DEBTOR_ID,
  dayFromToday,
  debtor,
  guide,
  nextAction,
  TODAY,
} from '../test/fixtures.ts';
import {
  apiError,
  deferred,
  EMPTY_PROFILE,
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
const EVENTS = `POST /api/claims/${CLAIM_ID}/events`;
const EMAIL = `POST /api/claims/${CLAIM_ID}/email`;
const DEBTOR = `GET /api/debtors/${DEBTOR_ID}`;
const SAVE_DEBTOR = `PATCH /api/debtors/${DEBTOR_ID}`;
const PATH = `/reclamaciones/${CLAIM_ID}`;
const ADDRESS = 'pagos@talleres.example.com';

const debtorReply = (email: string | null) =>
  json(200, { data: { debtor: debtor({ email }) } });
const claimReply = (overrides: Partial<ClaimDetail> = {}) =>
  json(200, { data: claimDetail(overrides) });
// A business error: its extra figures travel in `details` as an object.
const bizError = (status: number, code: string, details?: unknown) =>
  json(status, {
    error: { code, message: 'x', request_id: 'r', details },
  });
const withName = (business_name: string | null) =>
  me({}, { ...EMPTY_PROFILE, business_name });

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
    [DEBTOR]: debtorReply(ADDRESS),
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

  describe('escalation guide', () => {
    const TOTAL = formatEUR(263_250);

    it('shows the next step, its reason, the date and the guide lists that are not empty', async () => {
      script({
        'GET /api/me': withName('Estudio Ejemplo'),
        [DETAIL]: claimReply({
          next_action: nextAction({
            guide: guide({
              prepare: ['Los números de las facturas.'],
              notes: ['Guarda una copia del mensaje.'],
            }),
          }),
        }),
      });
      renderApp(PATH);
      expect(
        await screen.findByRole('heading', {
          level: 3,
          name: 'Envía un recordatorio amable',
        }),
      ).toBeTruthy();
      const section = within(
        screen.getByRole('region', { name: 'Siguiente paso' }),
      );
      expect(section.getByText(/pauta orientativa de Reclama/)).toBeTruthy();
      expect(
        section.getByText('Sugerido a partir del 19/10/2026.'),
      ).toBeTruthy();
      const steps = section.getByRole('list', { name: 'Qué hacer' });
      expect(steps.tagName).toBe('OL');
      expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
      expect(section.getByText('Los números de las facturas.')).toBeTruthy();
      expect(section.getByText('Guarda una copia del mensaje.')).toBeTruthy();
      // Empty lists leave no heading behind.
      expect(section.queryByText('Qué puede pasar después')).toBeNull();
    });

    it('fills the reminder template with the claim and the profile', async () => {
      script({ 'GET /api/me': withName('Estudio Ejemplo') });
      renderApp(PATH);
      const area = await screen.findByRole<HTMLTextAreaElement>('textbox', {
        name: 'Texto para copiar',
      });
      expect(area.readOnly).toBe(true);
      expect(area.value).toBe(
        `Hola Talleres Ejemplo S.L.: siguen pendientes las facturas FA-2025-001 y FA-2025-002, por ${TOTAL}.\n\nEstudio Ejemplo`,
      );
      expect(screen.queryByText(/falta un dato/)).toBeNull();
    });

    it('puts the deadline of the letter (today + 10 days) in the demand template', async () => {
      script({
        'GET /api/me': withName('Estudio Ejemplo'),
        [DETAIL]: claimReply({
          next_action: nextAction({
            action: 'SEND_DEMAND',
            guide: guide({
              title: 'Envía el requerimiento formal',
              template: {
                text: 'Pague antes del {{deadline}}. {{sender_name}}',
                placeholders: ['deadline', 'sender_name'],
              },
            }),
          }),
        }),
      });
      renderApp(PATH);
      const area = await screen.findByRole<HTMLTextAreaElement>('textbox', {
        name: 'Texto para copiar',
      });
      expect(area.value).toBe(
        `Pague antes del ${formatDate(dayFromToday(10))}. Estudio Ejemplo`,
      );
    });

    it('uses the date of the latest demand and leaves a gap, with a note, for what it lacks', async () => {
      script({
        [DETAIL]: claimReply({
          next_action: nextAction({
            action: 'SEND_BUROFAX',
            guide: guide({
              title: 'Prepara un burofax',
              template: {
                text: 'Requerimiento de fecha {{demand_date}}, de {{sender_name}}.',
                placeholders: ['demand_date', 'sender_name'],
              },
            }),
          }),
          events: [
            claimEvent({
              id: 'e-1',
              kind: 'DEMAND_SENT',
              occurred_on: '2026-09-01',
            }),
            claimEvent({
              id: 'e-2',
              kind: 'DEMAND_SENT',
              occurred_on: '2026-09-10',
            }),
          ],
        }),
      });
      renderApp(PATH);
      const area = await screen.findByRole<HTMLTextAreaElement>('textbox', {
        name: 'Texto para copiar',
      });
      // The profile has no business name: a gap, never an invented one.
      expect(area.value).toBe('Requerimiento de fecha 10/09/2026, de […].');
      const note = screen.getByText(/falta un dato/);
      expect(note.textContent).toContain('tu nombre o razón social');
      expect(note.textContent).not.toContain('la fecha del requerimiento');
      expect(area.getAttribute('aria-describedby')).toBe(note.id);
    });

    it('says the demand date is missing when no demand was registered', async () => {
      script({
        [DETAIL]: claimReply({
          next_action: nextAction({
            action: 'SEND_BUROFAX',
            guide: guide({
              template: {
                text: 'Del {{demand_date}}',
                placeholders: ['demand_date'],
              },
            }),
          }),
        }),
      });
      renderApp(PATH);
      const area = await screen.findByRole<HTMLTextAreaElement>('textbox', {
        name: 'Texto para copiar',
      });
      expect(area.value).toBe('Del […]');
      expect(screen.getByText(/falta un dato/).textContent).toContain(
        'la fecha del requerimiento',
      );
    });

    it('shows the warnings of the server where they cannot be missed', async () => {
      script({
        [DETAIL]: claimReply({
          next_action: nextAction({
            warnings: [
              {
                code: 'POSSIBLE_LIMITATION',
                message:
                  'La factura más antigua venció hace más de cuatro años.',
              },
            ],
          }),
        }),
      });
      renderApp(PATH);
      const warning = await screen.findByRole('note');
      expect(warning.textContent).toBe(
        'Aviso: La factura más antigua venció hace más de cuatro años.',
      );
    });

    it.each([
      ['DONE', 'No quedan pasos pendientes', 'Marcada como pagada.'],
      ['BLOCKED', 'Revisa el tipo de deudor', 'El deudor es un consumidor.'],
    ])(
      'shows %s with its text and no template',
      async (action, title, reason) => {
        script({
          [DETAIL]: claimReply({
            next_action: nextAction({
              action,
              earliest_on: null,
              reason,
              guide: guide({ title, template: null }),
            }),
          }),
        });
        renderApp(PATH);
        expect(
          await screen.findByRole('heading', { name: title }),
        ).toBeTruthy();
        const section = within(
          screen.getByRole('region', { name: 'Siguiente paso' }),
        );
        expect(section.getByText(reason)).toBeTruthy();
        expect(section.queryByText(/Sugerido a partir/)).toBeNull();
        expect(section.queryByRole('textbox')).toBeNull();
        expect(
          section.queryByRole('button', { name: 'Copiar texto' }),
        ).toBeNull();
      },
    );

    it('copies the filled text and confirms it', async () => {
      script({ 'GET /api/me': withName('Estudio Ejemplo') });
      renderApp(PATH);
      const user = userEvent.setup();
      const write = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue(undefined);
      const area = await screen.findByRole<HTMLTextAreaElement>('textbox', {
        name: 'Texto para copiar',
      });
      await user.click(screen.getByRole('button', { name: 'Copiar texto' }));
      const confirmation = await screen.findByText('Texto copiado.');
      expect(write).toHaveBeenCalledWith(area.value);
      expect(confirmation.closest('[role=status]')).toBeTruthy();
    });

    it('asks to select the text by hand when the clipboard refuses', async () => {
      script();
      renderApp(PATH);
      const user = userEvent.setup();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
        new Error('denied'),
      );
      await screen.findByRole('textbox', { name: 'Texto para copiar' });
      await user.click(screen.getByRole('button', { name: 'Copiar texto' }));
      const message = await screen.findByText(
        'No hemos podido copiar, selecciónalo a mano.',
      );
      expect(message.closest('[role=status]')).toBeTruthy();
      expect(screen.queryByText('Texto copiado.')).toBeNull();
    });
  });

  describe('recorded steps', () => {
    const asOf = dayFromToday(-30);
    const field = (label: string) =>
      screen.getByLabelText<HTMLInputElement>(label);
    const kind = () =>
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Tipo de paso' });
    const open = async () => {
      renderApp(PATH);
      const user = userEvent.setup();
      await screen.findByRole('heading', { name: 'Registrar un paso' });
      return user;
    };
    const record = (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByRole('button', { name: 'Registrar paso' }));

    it('says so when nothing has been recorded', async () => {
      script();
      renderApp(PATH);
      expect(
        await screen.findByText('Aún no has registrado ningún paso.'),
      ).toBeTruthy();
    });

    it('lists the steps in the order the server sends them, with date and note', async () => {
      script({
        [DETAIL]: claimReply({
          events: [
            claimEvent({
              id: 'e-1',
              kind: 'REMINDER_SENT',
              occurred_on: '2026-10-20',
              note: 'Por WhatsApp',
            }),
            claimEvent({
              id: 'e-2',
              kind: 'DEMAND_SENT',
              occurred_on: '2026-10-28',
            }),
          ],
        }),
      });
      renderApp(PATH);
      const list = await screen.findByRole('list', {
        name: 'Pasos registrados',
      });
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain('Recordatorio enviado');
      expect(items[0]?.textContent).toContain('20/10/2026');
      expect(items[0]?.textContent).toContain('Por WhatsApp');
      expect(items[1]?.textContent).toContain('Requerimiento enviado');
      expect(items[1]?.textContent).toContain('28/10/2026');
      expect(
        screen.queryByText('Aún no has registrado ningún paso.'),
      ).toBeNull();
    });

    it('offers the six kinds of step, today as the date and a limit for it', async () => {
      script({ [DETAIL]: claimReply({ as_of: asOf }) });
      await open();
      expect(
        within(kind())
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([
        'Elige el tipo de paso',
        'Recordatorio enviado',
        'Requerimiento enviado',
        'Burofax enviado',
        'Monitorio presentado',
        'Marcada como cobrada',
        'Nota',
      ]);
      expect(field('Fecha del paso').value).toBe(TODAY);
      expect(field('Fecha del paso').max).toBe(TODAY);
      expect(field('Fecha del paso').min).toBe(asOf);
      expect(field('Nota (opcional)').maxLength).toBe(1000);
    });

    it('records a step, reloads the claim and moves the guide on', async () => {
      const api = script({
        [DETAIL]: [
          claimReply({ as_of: asOf }),
          claimReply({
            as_of: asOf,
            events: [claimEvent({ kind: 'REMINDER_SENT', occurred_on: TODAY })],
            next_action: nextAction({
              action: 'SEND_DEMAND',
              guide: guide({
                title: 'Envía el requerimiento formal',
                template: null,
              }),
            }),
          }),
        ],
        [EVENTS]: json(201, { data: { event: claimEvent() } }),
      });
      const user = await open();
      await user.selectOptions(kind(), 'REMINDER_SENT');
      await user.type(field('Nota (opcional)'), '  Enviado por WhatsApp ');
      await record(user);

      expect(
        await screen.findByRole('heading', {
          name: 'Envía el requerimiento formal',
        }),
      ).toBeTruthy();
      expect(api.lastBody(EVENTS)).toEqual({
        kind: 'REMINDER_SENT',
        occurred_on: TODAY,
        note: 'Enviado por WhatsApp',
      });
      expect(api.count(DETAIL)).toBe(2);
      expect(
        screen.getByText('Paso registrado.').closest('[role=status]'),
      ).toBeTruthy();
      const list = screen.getByRole('list', { name: 'Pasos registrados' });
      expect(within(list).getByText('Recordatorio enviado')).toBeTruthy();
      // The form is ready for the next step, and the cursor is back on its button.
      expect(field('Nota (opcional)').value).toBe('');
      expect(kind().value).toBe('');
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Registrar paso' }),
        );
      });
      expect(inMain().queryByRole('alert')).toBeNull();
    });

    it('leaves the note out when it is blank', async () => {
      const api = script({
        [DETAIL]: claimReply({ as_of: asOf }),
        [EVENTS]: json(201, { data: { event: claimEvent() } }),
      });
      const user = await open();
      await user.selectOptions(kind(), 'NOTE');
      await user.type(field('Nota (opcional)'), '   ');
      await record(user);
      await screen.findByText('Paso registrado.');
      expect(api.lastBody(EVENTS)).toEqual({
        kind: 'NOTE',
        occurred_on: TODAY,
      });
    });

    it('asks for the kind of step before sending anything', async () => {
      const api = script({ [DETAIL]: claimReply({ as_of: asOf }) });
      const user = await open();
      await record(user);
      const error = await screen.findByText('Elige el tipo de paso.', {
        selector: '.field-error',
      });
      expect(kind().getAttribute('aria-invalid')).toBe('true');
      expect(kind().getAttribute('aria-describedby')).toContain(error.id);
      await waitFor(() => {
        expect(document.activeElement).toBe(kind());
      });
      expect(api.count(EVENTS)).toBe(0);
    });

    it.each([
      ['an empty date', '', 'Elige la fecha del paso.'],
      [
        'a date in the future',
        dayFromToday(1),
        'La fecha del paso no puede ser futura.',
      ],
      [
        'a date before the claim was calculated',
        dayFromToday(-31),
        `La fecha del paso no puede ser anterior al ${formatDate(asOf)}`,
      ],
    ])('refuses %s without asking the server', async (_name, date, text) => {
      const api = script({ [DETAIL]: claimReply({ as_of: asOf }) });
      const user = await open();
      await user.selectOptions(kind(), 'NOTE');
      fireEvent.change(field('Fecha del paso'), { target: { value: date } });
      await record(user);
      const error = await screen.findByText(text, {
        selector: '.field-error',
        exact: false,
      });
      expect(
        field('Fecha del paso').getAttribute('aria-describedby'),
      ).toContain(error.id);
      expect(api.count(EVENTS)).toBe(0);
    });

    it.each([
      ['EVENT_IN_FUTURE', 'La fecha del paso no puede ser futura.'],
      [
        'EVENT_BEFORE_CLAIM',
        'La fecha del paso no puede ser anterior a la fecha de cálculo',
      ],
    ])('shows %s next to the date', async (code, text) => {
      script({
        [DETAIL]: claimReply({ as_of: asOf }),
        [EVENTS]: apiError(422, code),
      });
      const user = await open();
      await user.selectOptions(kind(), 'NOTE');
      await record(user);
      const error = await screen.findByText(text, {
        selector: '.field-error',
        exact: false,
      });
      const date = field('Fecha del paso');
      expect(date.getAttribute('aria-invalid')).toBe('true');
      expect(date.getAttribute('aria-describedby')).toContain(error.id);
      await waitFor(() => {
        expect(document.activeElement).toBe(date);
      });
      expect(screen.queryByText('Paso registrado.')).toBeNull();
    });

    it('says the claim has reached its limit of steps', async () => {
      script({
        [DETAIL]: claimReply({ as_of: asOf }),
        [EVENTS]: bizError(422, 'EVENT_LIMIT_REACHED', { limit: 200 }),
      });
      const user = await open();
      await user.selectOptions(kind(), 'NOTE');
      await record(user);
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'máximo de pasos registrados (200)',
      );
    });

    it('shows a rejected note next to its field', async () => {
      script({
        [DETAIL]: claimReply({ as_of: asOf }),
        [EVENTS]: apiError(400, 'VALIDATION_ERROR', [
          {
            path: 'note',
            message: 'Too big: expected string to have <=1000 characters',
          },
        ]),
      });
      const user = await open();
      await user.selectOptions(kind(), 'NOTE');
      await user.type(field('Nota (opcional)'), 'x');
      await record(user);
      expect(
        await screen.findByText(
          'Este campo admite como máximo 1000 caracteres.',
          { selector: '.field-error' },
        ),
      ).toBeTruthy();
    });
  });

  describe('sending the letter by email', () => {
    const SEND = 'Enviar la carta por email';
    const sent = (extra: Record<string, unknown> = {}) =>
      json(200, {
        data: {
          sent: true,
          mode: 'sandbox',
          delivered_to: 'sandbox',
          would_have_gone_to: ADDRESS,
          event_recorded: false,
          provider_id: 're_1',
          ...extra,
        },
      });
    const live = (eventRecorded: boolean) =>
      sent({
        mode: 'live',
        delivered_to: ADDRESS,
        would_have_gone_to: null,
        event_recorded: eventRecorded,
      });
    // The Idempotency-Key of every send, in order.
    const keysOf = (api: ReturnType<typeof script>) =>
      api.fetchMock.mock.calls
        .filter(
          ([input, init]) =>
            input === `/api/claims/${CLAIM_ID}/email` &&
            init?.method === 'POST',
        )
        .map(
          ([, init]) =>
            (init?.headers as Record<string, string>)['Idempotency-Key'],
        );
    // Presses the button and waits until it is idle again.
    const press = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('button', { name: SEND }));
      await screen.findByRole('button', { name: SEND });
    };

    it('says before the click that in the demo and in test mode nothing reaches the debtor', async () => {
      const api = script();
      renderApp(PATH);
      await screen.findByRole('button', { name: SEND });
      const section = screen.getByRole('region', { name: SEND });
      expect(section.textContent).toContain('el email NO sale hacia el deudor');
      expect(section.textContent).toContain(ADDRESS);
      expect(api.count(EMAIL)).toBe(0);
    });

    it('reports a test send as such and does not move the guide', async () => {
      const api = script({ [EMAIL]: sent() });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      const status = (
        await screen.findByText(
          'Envío de prueba: el deudor no ha recibido nada.',
        )
      ).closest('[role=status]') as HTMLElement;
      expect(status.textContent).toContain(`habría ido a ${ADDRESS}`);
      expect(status.textContent).toContain('No se ha registrado ningún paso');
      expect(api.count(DETAIL)).toBe(1);
      expect(
        screen.getByRole('heading', { name: 'Envía un recordatorio amable' }),
      ).toBeTruthy();
      expect(inMain().queryByRole('alert')).toBeNull();
      expect(keysOf(api)[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    });

    it('reports a real send, and reloads the claim when the step was recorded', async () => {
      const api = script({ [EMAIL]: live(true) });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      const status = (
        await screen.findByText(`Carta enviada a ${ADDRESS}.`)
      ).closest('[role=status]') as HTMLElement;
      expect(status.textContent).toContain(
        'Hemos registrado el paso «Requerimiento enviado»',
      );
      await waitFor(() => {
        expect(api.count(DETAIL)).toBe(2);
      });
    });

    it('tells the person to record the step by hand when the server could not', async () => {
      const api = script({ [EMAIL]: live(false) });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      expect(
        await screen.findByText(/No hemos podido registrar el paso/),
      ).toBeTruthy();
      expect(api.count(DETAIL)).toBe(1);
    });

    it('disables the button while sending, then gives the focus back', async () => {
      const gate = deferred(sent());
      script({ [EMAIL]: gate.reply });
      renderApp(PATH);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: SEND }));
      const busy = await screen.findByRole('button', { name: 'Enviando…' });
      expect(busy.hasAttribute('disabled')).toBe(true);
      gate.release();
      const button = await screen.findByRole('button', { name: SEND });
      await waitFor(() => {
        expect(document.activeElement).toBe(button);
      });
    });

    it('repeats the key after a network error or a 502, and renews it once a send went out', async () => {
      const api = script({
        [EMAIL]: [
          networkError,
          bizError(502, 'EMAIL_PROVIDER_ERROR', { reason: 'unavailable' }),
          sent(),
          sent(),
        ],
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'No hemos podido conectar',
      );
      await press(user);
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'no se envía dos veces',
      );
      await press(user);
      await screen.findByText(/Envío de prueba/);
      expect(inMain().queryByRole('alert')).toBeNull();
      await press(user);
      const [first, second, third, fourth] = keysOf(api);
      expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(fourth).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(fourth).not.toBe(third);
    });

    it('starts a new attempt after a 409, because that key already sent an email', async () => {
      const api = script({
        [EMAIL]: [apiError(409, 'EMAIL_ALREADY_SENT'), sent()],
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'Este envío ya se había hecho',
      );
      await press(user);
      const [first, second] = keysOf(api);
      expect(second).not.toBe(first);
    });

    it('names the missing profile fields and links to the profile', async () => {
      script({
        [EMAIL]: apiError(422, 'PROFILE_INCOMPLETE', [
          { path: 'tax_id', message: 'x' },
        ]),
      });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      const alert = await inMain().findByRole('alert');
      expect(alert.textContent).toContain(
        'faltan datos en tu perfil: NIF/CIF.',
      );
      expect(
        within(alert)
          .getByRole('link', { name: 'Completar el perfil' })
          .getAttribute('href'),
      ).toBe('/perfil');
    });

    it.each<[string, Reply, string]>([
      [
        'a debtor without email',
        apiError(422, 'DEBTOR_EMAIL_MISSING'),
        'El deudor no tiene email.',
      ],
      [
        'a claim that changed',
        bizError(422, 'CLAIM_NOT_ACTIONABLE', { reason: 'invoice_paid' }),
        'Una de las facturas se ha cobrado por completo',
      ],
      [
        'a claim marked as paid',
        bizError(422, 'CLAIM_NOT_ACTIONABLE', { reason: 'marked_paid' }),
        'marcada como cobrada',
      ],
      [
        'a letter that is not available',
        apiError(422, 'LETTER_NOT_AVAILABLE'),
        'No hemos podido generar la carta',
      ],
      [
        'a rate limit with Retry-After',
        apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '7200' }),
        'Has llegado al límite de envíos por email. Demasiados intentos. Espera 2 horas',
      ],
      [
        'a rate limit without a body',
        empty(429),
        'Has llegado al límite de envíos por email. Demasiados intentos. Espera unos minutos',
      ],
      [
        'a provider that is down',
        bizError(502, 'EMAIL_PROVIDER_ERROR', { reason: 'unavailable' }),
        'no ha podido enviar el mensaje ahora mismo',
      ],
      [
        'a provider that rejects the message',
        bizError(502, 'EMAIL_PROVIDER_ERROR', { reason: 'rejected' }),
        'ha rechazado el mensaje',
      ],
      [
        'sending that is not configured',
        apiError(503, 'EMAIL_NOT_CONFIGURED'),
        'no está disponible en este servidor',
      ],
      ['an HTML gateway error', html(502), 'Algo ha fallado de nuestro lado'],
    ])('explains %s', async (_name, reply, text) => {
      script({ [EMAIL]: reply });
      renderApp(PATH);
      const user = userEvent.setup();
      await press(user);
      expect((await inMain().findByRole('alert')).textContent).toContain(text);
      expect(screen.queryByText(/Envío de prueba/)).toBeNull();
    });

    describe('when the debtor has no email', () => {
      const typeAddress = async (
        user: ReturnType<typeof userEvent.setup>,
        text: string,
      ) => {
        await user.type(await screen.findByLabelText('Email del deudor'), text);
        await user.click(screen.getByRole('button', { name: 'Guardar' }));
      };

      it('does not offer to send, saves the address and then enables the send', async () => {
        const api = script({
          [DEBTOR]: [debtorReply(null), debtorReply(ADDRESS)],
          [SAVE_DEBTOR]: debtorReply(ADDRESS),
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await screen.findByLabelText('Email del deudor');
        expect(screen.queryByRole('button', { name: SEND })).toBeNull();
        await typeAddress(user, '  Pagos@Talleres.Example.com ');
        const send = await screen.findByRole('button', { name: SEND });
        expect(api.lastBody(SAVE_DEBTOR)).toEqual({ email: ADDRESS });
        expect(api.count(DEBTOR)).toBe(2);
        await waitFor(() => {
          expect(document.activeElement).toBe(send);
        });
        expect(screen.queryByLabelText('Email del deudor')).toBeNull();
      });

      it('refuses a malformed address without asking the server', async () => {
        const api = script({ [DEBTOR]: debtorReply(null) });
        renderApp(PATH);
        const user = userEvent.setup();
        await typeAddress(user, 'no-es-un-email');
        const error = await screen.findByText(
          'Escribe un email válido, por ejemplo nombre@empresa.es.',
          { selector: '.field-error' },
        );
        const input = screen.getByLabelText('Email del deudor');
        expect(input.getAttribute('aria-describedby')).toContain(error.id);
        await waitFor(() => {
          expect(document.activeElement).toBe(input);
        });
        expect(api.count(SAVE_DEBTOR)).toBe(0);
      });

      it('shows what the server says about the address', async () => {
        script({
          [DEBTOR]: debtorReply(null),
          [SAVE_DEBTOR]: apiError(400, 'VALIDATION_ERROR', [
            { path: 'email', message: 'Invalid email' },
          ]),
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await typeAddress(user, 'a@b.example.com');
        expect(
          await screen.findByText(
            'Escribe un email válido, por ejemplo nombre@empresa.es.',
            { selector: '.field-error' },
          ),
        ).toBeTruthy();
        expect(screen.queryByRole('button', { name: SEND })).toBeNull();
      });
    });

    it('offers to retry when the debtor cannot be loaded, and recovers', async () => {
      script({ [DEBTOR]: [networkError, debtorReply(ADDRESS)] });
      renderApp(PATH);
      const user = userEvent.setup();
      expect((await inMain().findByRole('alert')).textContent).toContain(
        'No hemos podido conectar',
      );
      expect(screen.queryByRole('button', { name: SEND })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Reintentar' }));
      expect(await screen.findByRole('button', { name: SEND })).toBeTruthy();
    });
  });
});
