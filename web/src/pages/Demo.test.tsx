// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
import { renderApp, sessionSettled } from '../test/render.tsx';

afterEach(cleanup);

const started = json(201, {
  data: {
    user: { id: 'd1', is_demo: true },
    expires_at: '2026-10-20T10:00:00.000Z',
    session_expires_at: '2026-10-19T12:00:00.000Z',
  },
});

async function openDemo() {
  const router = renderApp('/demo');
  await sessionSettled();
  return { router, user: userEvent.setup() };
}

const startButton = () =>
  screen.getByRole('button', { name: /Empezar la demo|Reintentar/ });
const alertBox = () => document.querySelector('.form-alert');

describe('Demo', () => {
  it('creates nothing on load: only the button does', async () => {
    const { count } = mockApi({ 'GET /api/me': UNAUTHENTICATED });
    await openDemo();
    expect(count('POST /api/demo/session')).toBe(0);
    expect(startButton().textContent).toBe('Empezar la demo');
    expect(document.title).toBe('Probar la demo · Reclama');
  });

  it('starts the demo, loads the session and opens the panel with the banner', async () => {
    mockApi({
      'GET /api/me': [UNAUTHENTICATED, me({ is_demo: true })],
      'POST /api/demo/session': started,
    });
    const { user, router } = await openDemo();
    await user.click(startButton());
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/panel');
    });
    expect(await screen.findByText(/Modo demo/)).toBeTruthy();
  });

  it.each([
    [
      '429 with Retry-After',
      apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '1800' }),
      'Demasiados intentos. Espera 30 minutos y vuelve a intentarlo.',
      'Empezar la demo',
    ],
    [
      'an empty 429',
      empty(429),
      'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
      'Empezar la demo',
    ],
    [
      '503 DEMO_FULL',
      apiError(503, 'DEMO_FULL'),
      'La demo está llena ahora mismo. Inténtalo en unos minutos o crea una cuenta.',
      'Empezar la demo',
    ],
    [
      '503 DEMO_UNAVAILABLE',
      apiError(503, 'DEMO_UNAVAILABLE'),
      'La demo no está disponible ahora mismo.',
      'Empezar la demo',
    ],
    [
      'a network failure',
      networkError,
      'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',
      'Reintentar',
    ],
    [
      'a 500',
      apiError(500, 'INTERNAL_ERROR'),
      'Algo ha fallado de nuestro lado. Inténtalo de nuevo en unos minutos.',
      'Reintentar',
    ],
  ])('says the right thing for %s', async (_name, reply, message, label) => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/demo/session': reply,
    });
    const { user, router } = await openDemo();
    await user.click(startButton());
    expect(await screen.findByText(message)).toBeTruthy();
    expect(alertBox()?.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(alertBox());
    expect(startButton().textContent).toBe(label);
    expect(router.state.location.pathname).toBe('/demo');
  });

  it('lets the visitor retry after a network failure', async () => {
    const { count } = mockApi({
      'GET /api/me': [UNAUTHENTICATED, me({ is_demo: true })],
      'POST /api/demo/session': [networkError, started],
    });
    const { user, router } = await openDemo();
    await user.click(startButton());
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/panel');
    });
    expect(count('POST /api/demo/session')).toBe(2);
  });

  it('creates one sandbox even if the button is pressed twice', async () => {
    const gate = deferred(started);
    const { count } = mockApi({
      'GET /api/me': [UNAUTHENTICATED, me({ is_demo: true })],
      'POST /api/demo/session': gate.reply,
    });
    const { user, router } = await openDemo();
    await user.click(startButton());
    const busy = screen.getByRole('button', { name: 'Preparando la demo…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(count('POST /api/demo/session')).toBe(1);
    gate.release();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/panel');
    });
    expect(count('POST /api/demo/session')).toBe(1);
  });

  it('does not offer a second sandbox to someone who is already signed in', async () => {
    mockApi({ 'GET /api/me': me() });
    renderApp('/demo');
    expect(
      await screen.findByRole('link', { name: 'Ir a mis facturas' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Empezar la demo' }),
    ).toBeNull();
  });
});
