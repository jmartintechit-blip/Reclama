// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  deferred,
  empty,
  html,
  json,
  me,
  mockApi,
  networkError,
  UNAUTHENTICATED,
} from '../test/mock-api.ts';
import { renderApp, sessionSettled } from '../test/render.tsx';

afterEach(cleanup);

const EMAIL = 'ana@example.test';
const PASSWORD = 'correct horse battery';

// /api/me answers 401 until the sign-in call has succeeded, then the user.
const meAfterSignIn = [UNAUTHENTICATED, me()];
const created = json(201, { data: { user: { id: 'u1', email: EMAIL } } });
const signedIn = json(200, { data: { user: { id: 'u1', email: EMAIL } } });

async function openForm(path: '/entrar' | '/registro', state?: unknown) {
  const router = renderApp(path, state);
  await sessionSettled();
  const user = userEvent.setup();
  return {
    router,
    user,
    email: screen.getByLabelText<HTMLInputElement>('Email'),
    password: screen.getByLabelText<HTMLInputElement>('Contraseña'),
    submit: screen.getByRole('button', {
      name: path === '/entrar' ? 'Entrar' : 'Crear cuenta',
    }),
  };
}

async function fillAndSubmit(
  form: Awaited<ReturnType<typeof openForm>>,
  email = EMAIL,
  password = PASSWORD,
) {
  if (email) await form.user.type(form.email, email);
  if (password) await form.user.type(form.password, password);
  await form.user.click(form.submit);
}

const summary = () => document.querySelector('[data-error-summary]');

describe('Login', () => {
  it('has labelled fields with the right autocomplete and no rule hint', async () => {
    const { email, password } = await openForm('/entrar');
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('email');
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect(password.getAttribute('aria-describedby')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Crea una' }).getAttribute('href'),
    ).toBe('/registro');
    expect(document.title).toBe('Entrar · Reclama');
  });

  it('signs in, loads the user and goes to the panel', async () => {
    mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/login': signedIn,
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form, `  ${EMAIL.toUpperCase()} `);
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/panel');
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Facturas' }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('sends the trimmed email and the password exactly as typed', async () => {
    const { lastBody } = mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/login': signedIn,
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form, `  ${EMAIL} `, ' pass word ');
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/panel');
    });
    expect(lastBody('POST /api/auth/login')).toEqual({
      email: EMAIL,
      password: ' pass word ',
    });
  });

  it('goes back to the page that asked for the sign-in', async () => {
    mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/login': signedIn,
    });
    const form = await openForm('/entrar', { from: '/perfil' });
    await fillAndSubmit(form);
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/perfil');
    });
  });

  it('shows the credentials message in the alert and puts focus there', async () => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/login': apiError(401, 'INVALID_CREDENTIALS'),
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form);
    const alert = await screen.findByText(
      'El email o la contraseña no son correctos.',
    );
    expect(alert.closest('[role="alert"]')).toBe(summary());
    await waitFor(() => {
      expect(document.activeElement).toBe(summary());
    });
    expect(form.router.state.location.pathname).toBe('/entrar');
    // The typed text survives a failed attempt.
    expect(form.email.value).toBe(EMAIL);
  });

  it('checks the fields before calling the server and focuses the first invalid one', async () => {
    const { count } = mockApi({ 'GET /api/me': UNAUTHENTICATED });
    const form = await openForm('/entrar');
    await form.user.click(form.submit);

    expect(count('POST /api/auth/login')).toBe(0);
    await waitFor(() => {
      expect(document.activeElement).toBe(form.email);
    });
    expect(form.email.getAttribute('aria-invalid')).toBe('true');
    expect(form.password.getAttribute('aria-invalid')).toBe('true');
    const described = document.getElementById(
      form.email.getAttribute('aria-describedby') ?? 'none',
    );
    expect(described?.textContent).toBe('Escribe tu email.');
    expect(summary()?.textContent).toContain('Email: Escribe tu email.');
    expect(summary()?.textContent).toContain(
      'Contraseña: Escribe tu contraseña.',
    );
  });

  it('flags a badly shaped email', async () => {
    mockApi({ 'GET /api/me': UNAUTHENTICATED });
    const form = await openForm('/entrar');
    await fillAndSubmit(form, 'ana@', PASSWORD);
    expect(
      await screen.findByText(
        'Escribe un email válido, por ejemplo nombre@empresa.es.',
        { selector: '.field-error' },
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(form.email);
  });

  it('maps a server validation detail to its field in Spanish', async () => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/login': apiError(400, 'VALIDATION_ERROR', [
        { path: 'password', message: 'Must have at most 128 characters' },
      ]),
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form);
    // At login a password the server refuses is simply not the right one.
    expect(
      await screen.findByText('La contraseña no es correcta.', {
        selector: '.field-error',
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(form.password);
    });
  });

  it.each([
    [
      'a 429 with Retry-After in seconds',
      apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '600' }),
      'Demasiados intentos. Espera 10 minutos y vuelve a intentarlo.',
    ],
    [
      'a 429 with Retry-After under a minute',
      apiError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '30' }),
      'Demasiados intentos. Espera 30 segundos y vuelve a intentarlo.',
    ],
    [
      'an empty 429 from the CDN edge',
      empty(429),
      'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
    ],
    [
      'a network failure',
      networkError,
      'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',
    ],
    [
      'a 500',
      apiError(500, 'INTERNAL_ERROR'),
      'Algo ha fallado de nuestro lado. Inténtalo de nuevo en unos minutos.',
    ],
    [
      'an HTML 502',
      html(502),
      'Algo ha fallado de nuestro lado. Inténtalo de nuevo en unos minutos.',
    ],
  ])('says the right thing for %s', async (_name, reply, message) => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/login': reply,
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form);
    expect(await screen.findByText(message)).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(summary());
    });
  });

  it('does not take a second submit while the first is in flight', async () => {
    const gate = deferred(signedIn);
    const { count } = mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/login': gate.reply,
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form);

    const button = screen.getByRole('button', { name: 'Entrando…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(form.submit.closest('form')?.getAttribute('aria-busy')).toBe('true');
    // Enter in a field submits the form even if the button looks disabled.
    fireEvent.submit(form.submit.closest('form') as HTMLFormElement);
    fireEvent.submit(form.submit.closest('form') as HTMLFormElement);
    expect(count('POST /api/auth/login')).toBe(1);

    gate.release();
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/panel');
    });
    expect(count('POST /api/auth/login')).toBe(1);
  });

  it('lets the password be shown and hidden with a real checkbox', async () => {
    const { user, password } = await openForm('/entrar');
    const toggle = screen.getByRole('checkbox', { name: 'Mostrar contraseña' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(password.type).toBe('password');
    await user.click(toggle);
    expect(password.type).toBe('text');
    await user.click(toggle);
    expect(password.type).toBe('password');
  });

  it('says the session could not be loaded if /api/me fails right after a good sign-in', async () => {
    mockApi({
      'GET /api/me': [UNAUTHENTICATED, networkError],
      'POST /api/auth/login': signedIn,
    });
    const form = await openForm('/entrar');
    await fillAndSubmit(form);
    expect(
      await screen.findByText(
        'No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',
      ),
    ).toBeTruthy();
    expect(form.router.state.location.pathname).toBe('/entrar');
  });
});

describe('Register', () => {
  it('shows the password rule, linked to the field, and asks for a new password', async () => {
    const { password } = await openForm('/registro');
    expect(password.autocomplete).toBe('new-password');
    const hint = document.getElementById(
      password.getAttribute('aria-describedby') ?? 'none',
    );
    expect(hint?.textContent).toBe('Mínimo 10 caracteres');
    expect(document.title).toBe('Crear cuenta · Reclama');
    expect(screen.queryByText(/Si vienes de la demo/)).toBeNull();
  });

  it('creates the account and goes to the panel', async () => {
    const { lastBody } = mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/register': created,
    });
    const form = await openForm('/registro');
    await fillAndSubmit(form);
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/panel');
    });
    expect(lastBody('POST /api/auth/register')).toEqual({
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it('refuses a short password without calling the server, and keeps the hint linked', async () => {
    const { count } = mockApi({ 'GET /api/me': UNAUTHENTICATED });
    const form = await openForm('/registro');
    await fillAndSubmit(form, EMAIL, 'corta');
    expect(count('POST /api/auth/register')).toBe(0);
    await waitFor(() => {
      expect(document.activeElement).toBe(form.password);
    });
    const ids = (form.password.getAttribute('aria-describedby') ?? '').split(
      ' ',
    );
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Mínimo 10 caracteres',
      'La contraseña necesita al menos 10 caracteres.',
    ]);
  });

  it('counts a password in characters, not in bytes', async () => {
    const { count } = mockApi({
      'GET /api/me': meAfterSignIn,
      'POST /api/auth/register': created,
    });
    const form = await openForm('/registro');
    // Ten emoji: 10 characters, 40 bytes.
    await fillAndSubmit(form, EMAIL, '🔑'.repeat(10));
    await waitFor(() => {
      expect(count('POST /api/auth/register')).toBe(1);
    });
  });

  it('focuses the email when both fields are wrong', async () => {
    mockApi({ 'GET /api/me': UNAUTHENTICATED });
    const form = await openForm('/registro');
    await fillAndSubmit(form, 'nope', 'corta');
    await waitFor(() => {
      expect(document.activeElement).toBe(form.email);
    });
    expect(form.password.getAttribute('aria-invalid')).toBe('true');
  });

  it('says the email is taken on the email field and focuses it', async () => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/register': apiError(409, 'EMAIL_TAKEN'),
    });
    const form = await openForm('/registro');
    await fillAndSubmit(form);
    expect(
      await screen.findByText(
        'Ya hay una cuenta con ese email. Entra o usa otro.',
        { selector: '.field-error' },
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(form.email);
    });
    expect(form.router.state.location.pathname).toBe('/registro');
  });

  it('maps the server password rules to Spanish', async () => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/register': apiError(400, 'VALIDATION_ERROR', [
        { path: 'password', message: 'Must have at least 10 characters' },
        { path: 'email', message: 'Must be a valid email address' },
        { path: 'unknown', message: 'whatever' },
      ]),
    });
    const form = await openForm('/registro');
    await fillAndSubmit(form);
    expect(
      await screen.findByText(
        'La contraseña necesita al menos 10 caracteres.',
        {
          selector: '.field-error',
        },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Escribe un email válido, por ejemplo nombre@empresa.es.',
        {
          selector: '.field-error',
        },
      ),
    ).toBeTruthy();
    // Nothing the server says is shown in English.
    expect(document.body.textContent).not.toMatch(/Must |whatever/);
  });

  it('says how long to wait when the sign-up limit is reached', async () => {
    mockApi({
      'GET /api/me': UNAUTHENTICATED,
      'POST /api/auth/register': apiError(429, 'RATE_LIMITED', undefined, {
        'Retry-After': '3300',
      }),
    });
    const form = await openForm('/registro');
    await fillAndSubmit(form);
    expect(
      await screen.findByText(
        'Demasiados intentos. Espera 55 minutos y vuelve a intentarlo.',
      ),
    ).toBeTruthy();
  });

  it('tells a demo user that the new account starts empty, and then leaves the demo', async () => {
    mockApi({
      'GET /api/me': [me({ is_demo: true }), me()],
      'POST /api/auth/register': created,
    });
    const form = await openForm('/registro');
    expect(
      screen.getByText(
        /Si vienes de la demo, la cuenta nueva empieza sin datos/,
      ),
    ).toBeTruthy();
    await fillAndSubmit(form);
    await waitFor(() => {
      expect(form.router.state.location.pathname).toBe('/panel');
    });
    expect(screen.queryByText(/Modo demo/)).toBeNull();
  });
});
