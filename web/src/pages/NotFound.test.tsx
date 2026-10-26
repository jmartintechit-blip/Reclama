// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockApi, UNAUTHENTICATED } from '../test/mock-api.ts';
import { renderApp, sessionSettled } from '../test/render.tsx';

afterEach(cleanup);

describe('NotFound', () => {
  it('tells search engines not to index an unknown path', async () => {
    mockApi({ 'GET /api/me': UNAUTHENTICATED });
    renderApp('/no-such-page');
    await sessionSettled();
    expect(
      screen.getByRole('heading', { name: /No encontramos/ }),
    ).toBeTruthy();
    expect(
      document.querySelector('meta[name="robots"]')?.getAttribute('content'),
    ).toBe('noindex');
  });
});
