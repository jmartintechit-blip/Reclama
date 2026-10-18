import { render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../routes.tsx';

// Mounts the real routes (session provider and layout included) at `path`.
export function renderApp(path: string, state?: unknown) {
  const [pathname = '/', query] = path.split('?');
  const router = createMemoryRouter(routes, {
    initialEntries: [
      { pathname, search: query === undefined ? '' : `?${query}`, state },
    ],
  });
  render(<RouterProvider router={router} />);
  return router;
}

// Waits for the first GET /api/me to be answered: the header marks itself busy until then, and
// state that changes after a test ends would only produce act() noise.
export async function sessionSettled() {
  await waitFor(() => {
    expect(
      screen
        .getByRole('navigation', { name: 'Principal' })
        .getAttribute('aria-busy'),
    ).not.toBe('true');
  });
}
