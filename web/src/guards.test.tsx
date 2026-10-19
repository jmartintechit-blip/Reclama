// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  empty,
  me,
  mockApi,
  networkError,
  UNAUTHENTICATED,
} from './test/mock-api.ts';
import { renderApp, sessionSettled } from './test/render.tsx';

afterEach(cleanup);

beforeEach(() => {
  mockApi({ 'GET /api/me': UNAUTHENTICATED });
});

async function renderAt(path: string, state?: unknown) {
  const router = renderApp(path, state);
  await sessionSettled();
  return router;
}

describe('route guards', () => {
  it('sends an anonymous visitor to /entrar and remembers the path in the state, not the URL', async () => {
    const router = renderApp('/perfil?x=1');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    expect(router.state.location.search).toBe('');
    expect(router.state.location.state).toEqual({ from: '/perfil?x=1' });
  });

  it.each([
    '/panel',
    '/facturas/2b9df557-69f0-4aa3-a1d3-784ea6a42b1c',
    '/importar',
    '/reclamaciones',
    '/reclamaciones/nueva?deudor=d1',
    '/reclamaciones/2b9df557-69f0-4aa3-a1d3-784ea6a42b1c',
    '/perfil',
  ])('protects %s', async (path) => {
    const router = renderApp(path);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
  });

  it('shows "Cargando…" while the session is unknown and then the page', async () => {
    mockApi({ 'GET /api/me': me() });
    renderApp('/perfil');
    expect(screen.getByRole('status').textContent).toBe('Cargando…');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Perfil' }),
    ).toBeTruthy();
  });

  it('offers to retry when the session cannot be checked, and recovers', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': [networkError, me()] });
    renderApp('/perfil');
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Perfil' }),
    ).toBeTruthy();
  });

  it('sends a signed-in user away from /entrar to the remembered path, or the panel', async () => {
    mockApi({ 'GET /api/me': me() });
    const plain = renderApp('/entrar');
    await waitFor(() => {
      expect(plain.state.location.pathname).toBe('/panel');
    });
    cleanup();
    const remembered = renderApp('/registro', { from: '/perfil' });
    await waitFor(() => {
      expect(remembered.state.location.pathname).toBe('/perfil');
    });
  });

  it('ignores a remembered path that leaves the app', async () => {
    mockApi({ 'GET /api/me': me() });
    const router = renderApp('/entrar', { from: '//evil.example/x' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/panel');
    });
  });

  it('lets a demo user see /registro (a real account is the way out of the demo)', async () => {
    mockApi({ 'GET /api/me': me({ is_demo: true }) });
    const router = await renderAt('/registro');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Crear cuenta' }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/registro');
  });

  it('goes back to the login when a call finds the session gone, remembering the page', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': me(),
      'PATCH /api/me/profile': UNAUTHENTICATED,
    });
    const router = renderApp('/perfil');
    await user.click(
      await screen.findByRole('button', { name: 'Guardar perfil' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    expect(router.state.location.state).toEqual({ from: '/perfil' });
  });
});

describe('header navigation by session', () => {
  const linkNames = () =>
    within(screen.getByRole('navigation', { name: 'Principal' }))
      .getAllByRole('link')
      .map((link) => link.textContent);

  it('shows Método, Privacidad and Entrar to an anonymous visitor', async () => {
    await renderAt('/');
    expect(linkNames()).toEqual(['Método', 'Privacidad', 'Entrar']);
    expect(screen.queryByRole('button', { name: 'Salir' })).toBeNull();
    expect(screen.queryByText(/Modo demo/)).toBeNull();
  });

  it('shows no Entrar button while the session is still loading', async () => {
    mockApi({ 'GET /api/me': me() });
    renderApp('/');
    expect(linkNames()).toEqual(['Método', 'Privacidad']);
    await sessionSettled();
  });

  it('shows the app links and Salir to a signed-in user, with aria-current', async () => {
    mockApi({ 'GET /api/me': me() });
    await renderAt('/perfil');
    expect(linkNames()).toEqual([
      'Facturas',
      'Importar',
      'Reclamaciones',
      'Perfil',
    ]);
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(
      within(nav)
        .getByRole('link', { name: 'Perfil' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(nav).getByRole('link', { name: 'Facturas' }).getAttribute('href'),
    ).toBe('/panel');
    expect(within(nav).getByRole('button', { name: 'Salir' })).toBeTruthy();
    expect(screen.queryByText(/Modo demo/)).toBeNull();
  });

  it('signs out with Salir: a protected page sends the visitor home, not to the login', async () => {
    const user = userEvent.setup();
    const { count } = mockApi({
      'GET /api/me': me(),
      'POST /api/auth/logout': empty(204),
    });
    const router = await renderAt('/perfil');
    await user.click(screen.getByRole('button', { name: 'Salir' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(router.state.location.state).toBeNull();
    expect(count('POST /api/auth/logout')).toBe(1);
    expect(linkNames()).toEqual(['Método', 'Privacidad', 'Entrar']);
  });

  it('says so when the sign-out could not be done, and stays signed in', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': me(),
      'POST /api/auth/logout': networkError,
    });
    const router = await renderAt('/perfil');
    await user.click(screen.getByRole('button', { name: 'Salir' }));
    expect(
      await screen.findByText(/No hemos podido cerrar la sesión/),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/perfil');
    expect(screen.getByRole('button', { name: 'Salir' })).toBeTruthy();
  });

  it('shows the demo banner with a link to create an account to a demo user', async () => {
    mockApi({ 'GET /api/me': me({ is_demo: true }) });
    await renderAt('/perfil');
    expect(
      screen.getByText(
        'Modo demo: los datos son ficticios y se borran a las 24 horas.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Crear mi cuenta' })
        .getAttribute('href'),
    ).toBe('/registro');
    expect(screen.getByRole('button', { name: 'Salir' })).toBeTruthy();
  });
});
