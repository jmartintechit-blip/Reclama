// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiError,
  empty,
  me,
  mockApi,
  networkError,
  UNAUTHENTICATED,
} from '../test/mock-api.ts';
import { api } from './api.ts';
import { SessionProvider, useSession } from './session.tsx';

afterEach(cleanup);

function Probe() {
  const { status, user, profile, refresh, signOut } = useSession();
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="user">{user ? (user.email ?? 'demo') : 'none'}</p>
      <p data-testid="profile">{profile?.default_compensation ?? 'none'}</p>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <button type="button" onClick={() => void signOut()}>
        signout
      </button>
      <button type="button" onClick={() => void api('GET', '/api/invoices')}>
        call
      </button>
    </div>
  );
}

const mount = () =>
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
const status = () => screen.getByTestId('status').textContent;

describe('SessionProvider', () => {
  it('starts loading and becomes authenticated with the user and the profile', async () => {
    mockApi({ 'GET /api/me': me() });
    mount();
    expect(status()).toBe('loading');
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    expect(screen.getByTestId('user').textContent).toBe('ana@example.test');
    expect(screen.getByTestId('profile').textContent).toBe('PER_CLAIM');
  });

  it('becomes anonymous on a 401', async () => {
    mockApi({ 'GET /api/me': UNAUTHENTICATED });
    mount();
    await waitFor(() => {
      expect(status()).toBe('anonymous');
    });
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('says unavailable, not anonymous, when /api/me cannot be answered', async () => {
    mockApi({ 'GET /api/me': networkError });
    mount();
    await waitFor(() => {
      expect(status()).toBe('unavailable');
    });
  });

  it('keeps a signed-in user when a later refresh fails on a hiccup', async () => {
    const user = userEvent.setup();
    const { count } = mockApi({ 'GET /api/me': [me(), apiError(503, 'X')] });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    await user.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => {
      expect(count('GET /api/me')).toBe(2);
    });
    expect(status()).toBe('authenticated');
  });

  it('flips to anonymous when any later call answers 401 UNAUTHENTICATED', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': me(), 'GET /api/invoices': UNAUTHENTICATED });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    await user.click(screen.getByRole('button', { name: 'call' }));
    await waitFor(() => {
      expect(status()).toBe('anonymous');
    });
  });

  it('does not flip on a 401 that is not about the session (wrong password)', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': me(),
      'GET /api/invoices': apiError(401, 'INVALID_CREDENTIALS'),
    });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    await user.click(screen.getByRole('button', { name: 'call' }));
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
  });

  it('signOut posts the logout and clears the state', async () => {
    const user = userEvent.setup();
    const { count } = mockApi({
      'GET /api/me': me(),
      'POST /api/auth/logout': empty(204),
    });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    await user.click(screen.getByRole('button', { name: 'signout' }));
    await waitFor(() => {
      expect(status()).toBe('anonymous');
    });
    expect(count('POST /api/auth/logout')).toBe(1);
    expect(screen.getByTestId('profile').textContent).toBe('none');
  });

  it('keeps the user signed in when the logout could not be sent', async () => {
    const user = userEvent.setup();
    const { count } = mockApi({
      'GET /api/me': me(),
      'POST /api/auth/logout': networkError,
    });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    await user.click(screen.getByRole('button', { name: 'signout' }));
    await waitFor(() => {
      expect(count('POST /api/auth/logout')).toBe(1);
    });
    expect(status()).toBe('authenticated');
  });

  it('never keeps a token anywhere in the browser storage', async () => {
    mockApi({ 'GET /api/me': me() });
    mount();
    await waitFor(() => {
      expect(status()).toBe('authenticated');
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
