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
  empty,
  json,
  me,
  mockApi,
  networkError,
  UNAUTHENTICATED,
} from '../test/mock-api.ts';
import { renderApp } from '../test/render.tsx';

afterEach(cleanup);

const IBAN = 'ES9121000418450200051332';
const FULL = {
  business_name: 'Taller Ficticio S.L.',
  tax_id: 'B00000000',
  address: 'Calle Falsa 1\n28000 Madrid',
  iban: IBAN,
  default_compensation: 'PER_INVOICE',
};

async function openProfile() {
  const router = renderApp('/perfil');
  await screen.findByRole('heading', { level: 1, name: 'Perfil' });
  return { router, user: userEvent.setup() };
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const summary = () => document.querySelector('form [data-error-summary]');
const save = () => screen.getByRole('button', { name: 'Guardar perfil' });
const CONFIRM_LABEL = 'Escribe tu contraseña para confirmar';

describe('Profile form', () => {
  it('loads the values from the session, with the IBAN grouped', async () => {
    mockApi({ 'GET /api/me': me({}, FULL) });
    await openProfile();
    expect(field('Nombre o razón social').value).toBe('Taller Ficticio S.L.');
    expect(field('NIF/CIF').value).toBe('B00000000');
    expect(field('Dirección').value).toBe('Calle Falsa 1\n28000 Madrid');
    expect(field('IBAN (opcional)').value).toBe(
      'ES91 2100 0418 4502 0005 1332',
    );
    expect(
      screen.getByRole<HTMLInputElement>('radio', {
        name: /40 € por factura vencida/,
      }).checked,
    ).toBe(true);
    expect(document.title).toBe('Perfil · Reclama');
  });

  it('shows the empty profile of a new account with the default option selected', async () => {
    mockApi({
      'GET /api/me': me(
        {},
        {
          business_name: null,
          tax_id: null,
          address: null,
          iban: null,
          default_compensation: 'PER_CLAIM',
        },
      ),
    });
    await openProfile();
    expect(field('NIF/CIF').value).toBe('');
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /por reclamación/ })
        .checked,
    ).toBe(true);
  });

  it('says the address limit and explains each compensation option in plain Spanish', async () => {
    mockApi({ 'GET /api/me': me({}, FULL) });
    await openProfile();
    const hint = document.getElementById(
      field('Dirección').getAttribute('aria-describedby') ?? 'none',
    );
    expect(hint?.textContent).toContain('Máximo 6 líneas');

    const group = screen.getByRole('group', {
      name: 'Compensación por costes de cobro',
    });
    expect(group.textContent).toContain(
      'La jurisprudencia sobre los 40 € no es uniforme, por eso puedes elegir cómo se aplican.',
    );
    const explanations = within(group)
      .getAllByRole('radio')
      .map(
        (radio) =>
          document.getElementById(
            radio.getAttribute('aria-describedby') ?? 'none',
          )?.textContent,
      );
    expect(explanations).toEqual([
      expect.stringContaining('No sumas nada'),
      expect.stringContaining('por cada factura vencida'),
      expect.stringContaining('una sola vez'),
    ]);
    expect(
      within(group).getByRole('radio', { name: /Sin compensación/ }),
    ).toBeTruthy();
    expect(
      within(group).getByRole('radio', {
        name: /40 € por reclamación \(la lectura más prudente\)/,
      }),
    ).toBeTruthy();
  });

  it('saves, announces it, sends the typed values and refreshes the session', async () => {
    const saved = {
      ...FULL,
      business_name: 'Nuevo Nombre',
      default_compensation: 'NONE',
      address: null,
    };
    const { count, lastBody } = mockApi({
      'GET /api/me': me({}, FULL),
      'PATCH /api/me/profile': json(200, { data: { profile: saved } }),
    });
    const { user } = await openProfile();

    const name = field('Nombre o razón social');
    await user.clear(name);
    await user.type(name, '  Nuevo Nombre ');
    await user.clear(field('Dirección'));
    await user.click(screen.getByRole('radio', { name: /Sin compensación/ }));
    await user.click(save());

    const status = await screen.findByText('Perfil guardado.');
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(lastBody('PATCH /api/me/profile')).toEqual({
      business_name: 'Nuevo Nombre',
      tax_id: 'B00000000',
      address: null,
      iban: 'ES91 2100 0418 4502 0005 1332',
      default_compensation: 'NONE',
    });
    await waitFor(() => {
      expect(count('GET /api/me')).toBe(2);
    });
  });

  it('shows the server field errors in Spanish and focuses the first invalid field', async () => {
    mockApi({
      'GET /api/me': me({}, FULL),
      'PATCH /api/me/profile': apiError(400, 'VALIDATION_ERROR', [
        { path: 'iban', message: 'Must be a valid IBAN' },
        { path: 'address', message: 'Must have at most 6 lines' },
        {
          path: 'business_name',
          message: 'Too big: expected string to have <=200 characters',
        },
        { path: 'tax_id', message: 'Must not contain control characters' },
      ]),
    });
    const { user } = await openProfile();
    await user.type(field('IBAN (opcional)'), 'X');
    await user.click(save());

    const error = (text: string) =>
      screen.findByText(text, { selector: '.field-error' });
    expect(
      await error(
        'Este IBAN no es válido. Revísalo: los espacios no importan.',
      ),
    ).toBeTruthy();
    expect(
      await error('La dirección admite como máximo 6 líneas.'),
    ).toBeTruthy();
    expect(
      await error('Este campo admite como máximo 200 caracteres.'),
    ).toBeTruthy();
    expect(
      await error('Este campo contiene caracteres que no se admiten.'),
    ).toBeTruthy();

    // DOM order decides which field is first: the name.
    await waitFor(() => {
      expect(document.activeElement).toBe(field('Nombre o razón social'));
    });
    for (const label of [
      'Nombre o razón social',
      'NIF/CIF',
      'Dirección',
      'IBAN (opcional)',
    ]) {
      const input = field(label);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
      expect(
        ids.some(
          (id) => document.getElementById(id)?.className === 'field-error',
        ),
      ).toBe(true);
    }
    expect(summary()?.getAttribute('role')).toBe('alert');
    expect(document.body.textContent).not.toMatch(/Must |Too big/);
    expect(screen.queryByText('Perfil guardado.')).toBeNull();
  });

  it('keeps what was typed when the save fails, and says why', async () => {
    mockApi({
      'GET /api/me': me({}, FULL),
      'PATCH /api/me/profile': networkError,
    });
    const { user } = await openProfile();
    const name = field('Nombre o razón social');
    await user.clear(name);
    await user.type(name, 'Sin guardar');
    await user.click(save());
    expect(
      await screen.findByText(
        'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',
      ),
    ).toBeTruthy();
    expect(field('Nombre o razón social').value).toBe('Sin guardar');
    expect(document.activeElement).toBe(summary());
  });

  it('says how long to wait on a 429', async () => {
    mockApi({
      'GET /api/me': me({}, FULL),
      'PATCH /api/me/profile': apiError(429, 'RATE_LIMITED', undefined, {
        'Retry-After': '120',
      }),
    });
    const { user } = await openProfile();
    await user.click(save());
    expect(
      await screen.findByText(
        'Demasiados intentos. Espera 2 minutos y vuelve a intentarlo.',
      ),
    ).toBeTruthy();
  });

  it('does not save twice while a save is in flight', async () => {
    const gate = deferred(json(200, { data: { profile: FULL } }));
    const { count } = mockApi({
      'GET /api/me': me({}, FULL),
      'PATCH /api/me/profile': gate.reply,
    });
    const { user } = await openProfile();
    await user.click(save());
    const busy = screen.getByRole('button', { name: 'Guardando…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(busy.closest('form') as HTMLFormElement);
    expect(count('PATCH /api/me/profile')).toBe(1);
    gate.release();
    await screen.findByText('Perfil guardado.');
  });
});

describe('Delete account', () => {
  const open = async () => {
    const view = await openProfile();
    const opener = screen.getByRole('button', { name: 'Borrar mi cuenta' });
    return { ...view, opener };
  };
  const confirmWith = async (
    user: ReturnType<typeof userEvent.setup>,
    password: string,
  ) => {
    if (password)
      await user.type(screen.getByLabelText(CONFIRM_LABEL), password);
    await user.click(screen.getByRole('button', { name: 'Sí, borrar todo' }));
  };

  it('asks for confirmation in a second step before anything is sent', async () => {
    const { count } = mockApi({ 'GET /api/me': me({}, FULL) });
    const { user, opener } = await open();
    expect(
      screen.queryByRole('button', { name: 'Sí, borrar todo' }),
    ).toBeNull();
    expect(
      screen.getByText(/Se borra todo: tu perfil, tus facturas/),
    ).toBeTruthy();

    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText(CONFIRM_LABEL));
    expect(
      screen.getByRole('button', { name: 'Sí, borrar todo' }),
    ).toBeTruthy();
    expect(count('DELETE /api/me')).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText(CONFIRM_LABEL)).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Borrar mi cuenta' }),
    );
    expect(count('DELETE /api/me')).toBe(0);
  });

  it('deletes with the password and goes home as an anonymous visitor', async () => {
    const { lastBody } = mockApi({
      'GET /api/me': [me({}, FULL), UNAUTHENTICATED],
      'DELETE /api/me': empty(204),
    });
    const { user, opener, router } = await open();
    await user.click(opener);
    await confirmWith(user, 'mi contraseña');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(lastBody('DELETE /api/me')).toEqual({ password: 'mi contraseña' });
    expect(
      await within(
        screen.getByRole('navigation', { name: 'Principal' }),
      ).findByRole('link', { name: 'Entrar' }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });

  it('keeps the account and says so when the password is wrong', async () => {
    mockApi({
      'GET /api/me': me({}, FULL),
      'DELETE /api/me': apiError(401, 'INVALID_CREDENTIALS'),
    });
    const { user, opener, router } = await open();
    await user.click(opener);
    await confirmWith(user, 'mal');

    expect(
      await screen.findByText('La contraseña no es correcta.', {
        selector: '.field-error',
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(CONFIRM_LABEL));
    });
    // A wrong password is not an expired session: the person stays signed in, on the page.
    expect(router.state.location.pathname).toBe('/perfil');
    expect(screen.getByRole('button', { name: 'Salir' })).toBeTruthy();
  });

  it('does not call the server with an empty password', async () => {
    const { count } = mockApi({ 'GET /api/me': me({}, FULL) });
    const { user, opener } = await open();
    await user.click(opener);
    await confirmWith(user, '');
    expect(
      await screen.findByText('Escribe tu contraseña.', {
        selector: '.field-error',
      }),
    ).toBeTruthy();
    expect(count('DELETE /api/me')).toBe(0);
  });

  it.each([
    [
      'a 429',
      apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '900' }),
      'Demasiados intentos. Espera 15 minutos y vuelve a intentarlo.',
    ],
    [
      'a network failure',
      networkError,
      'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',
    ],
    [
      'a 403 for a demo account',
      apiError(403, 'DEMO_ACCOUNT'),
      'En la demo no se puede borrar la cuenta: caduca sola a las 24 horas.',
    ],
    [
      'a 403 for another reason',
      apiError(403, 'FORBIDDEN_ORIGIN'),
      'No tienes permiso para hacer esto.',
    ],
  ])(
    'shows a message and stays on the page for %s',
    async (_name, reply, message) => {
      mockApi({ 'GET /api/me': me({}, FULL), 'DELETE /api/me': reply });
      const { user, opener, router } = await open();
      await user.click(opener);
      await confirmWith(user, 'x');
      expect(await screen.findByText(message)).toBeTruthy();
      expect(router.state.location.pathname).toBe('/perfil');
      expect(
        screen.getByRole('button', { name: 'Sí, borrar todo' }),
      ).toBeTruthy();
    },
  );

  it('shows a demo user the explanation instead of the form', async () => {
    mockApi({ 'GET /api/me': me({ is_demo: true }, FULL) });
    await openProfile();
    expect(
      screen.getByText(
        'En la demo no se puede borrar la cuenta: caduca sola a las 24 horas.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Borrar mi cuenta' }),
    ).toBeNull();
    expect(screen.queryByLabelText(CONFIRM_LABEL)).toBeNull();
    // The demo can still edit its profile.
    expect(save()).toBeTruthy();
  });
});
