// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from './routes.tsx';

const NBSP = ' ';
const REPO = 'https://github.com/jmartintechit-blip/Reclama';

afterEach(cleanup);

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const PAGES: [path: string, h1: string][] = [
  ['/', 'Cobra lo que te deben, con los intereses que marca la ley.'],
  ['/metodo', 'Cómo se calculan los intereses de demora'],
  ['/privacidad', 'Privacidad'],
  ['/entrar', 'Próximamente'],
  ['/registro', 'Próximamente'],
  ['/demo', 'Próximamente'],
  ['/panel', 'Próximamente'],
  ['/esto-no-existe', 'No encontramos esta página'],
];

describe.each(PAGES)('page %s', (path, heading) => {
  it('has one h1, a main landmark, a skip link target and the legal notice', () => {
    renderAt(path);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading);

    const main = screen.getByRole('main');
    expect(main.id).toBe('contenido');
    const skip = screen.getByRole('link', { name: 'Saltar al contenido' });
    expect(skip.getAttribute('href')).toBe('#contenido');

    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(
      'Reclama es una herramienta informativa de ayuda al cobro, no asesoramiento jurídico.',
    );
    expect(footer.textContent).toContain(
      'Fuente de los tipos de interés: BOE.',
    );
    expect(
      within(footer)
        .getByRole('link', { name: 'Código en GitHub' })
        .getAttribute('href'),
    ).toBe(REPO);
  });

  it('has the header landmarks and a logo that goes home', () => {
    renderAt(path);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Reclama, inicio' })
        .getAttribute('href'),
    ).toBe('/');
  });
});

describe('Home', () => {
  it('shows the headline, both calls to action and the example', () => {
    const { container } = render(
      <RouterProvider router={createMemoryRouter(routes)} />,
    );
    expect(
      screen.getByRole('link', { name: 'Probar la demo' }).getAttribute('href'),
    ).toBe('/demo');
    expect(
      screen.getByRole('link', { name: 'Crear cuenta' }).getAttribute('href'),
    ).toBe('/registro');

    const list = screen.getByRole('list', { name: 'Tramos de intereses' });
    expect(list.querySelectorAll('li.seg')).toHaveLength(3);

    const totals = container.querySelector('.totals')?.textContent ?? '';
    expect(totals).toContain(`8.940,00${NBSP}€`);
    expect(totals).toContain(`1.006,20${NBSP}€`);
    expect(totals).toContain(`40,00${NBSP}€`);
    expect(totals).toContain(`9.986,20${NBSP}€`);

    expect(
      screen.getByRole('heading', { level: 2, name: /402 días/ }).textContent,
    ).toBe(
      `Así se calcula una factura de 8.940,00${NBSP}€ vencida hace 402 días`,
    );
    expect(
      screen.getByRole('list', { name: 'Cómo funciona' }).children,
    ).toHaveLength(3);
  });

  it('uses links or buttons for every button, never a div', () => {
    const { container } = render(
      <RouterProvider router={createMemoryRouter(routes)} />,
    );
    const buttons = [...container.querySelectorAll('.btn')];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      expect(['A', 'BUTTON']).toContain(button.tagName);
    }
  });
});

describe('navigation', () => {
  it('makes the skip link the first element that Tab reaches', async () => {
    renderAt('/');
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: 'Saltar al contenido' }),
    );
  });

  it('follows the header links and moves focus to the new page', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Principal' });

    await user.click(within(nav).getByRole('link', { name: 'Método' }));
    expect(router.state.location.pathname).toBe('/metodo');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Cómo se calculan los intereses de demora',
    );
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(
      within(nav)
        .getByRole('link', { name: 'Método' })
        .getAttribute('aria-current'),
    ).toBe('page');

    await user.click(within(nav).getByRole('link', { name: 'Privacidad' }));
    expect(router.state.location.pathname).toBe('/privacidad');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Privacidad',
    );

    await user.click(within(nav).getByRole('link', { name: 'Entrar' }));
    expect(router.state.location.pathname).toBe('/entrar');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Próximamente',
    );

    await user.click(screen.getByRole('link', { name: 'Volver a la portada' }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('sends the home buttons to the coming-soon screens', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    await user.click(screen.getByRole('link', { name: 'Probar la demo' }));
    expect(router.state.location.pathname).toBe('/demo');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Próximamente',
    );
  });

  it('does not move focus on the first render', () => {
    renderAt('/');
    expect(document.activeElement).toBe(document.body);
  });

  it('sets a title for each page', () => {
    renderAt('/metodo');
    expect(document.title).toBe('Método de cálculo · Reclama');
  });
});

describe('Method', () => {
  it('links to the legal sources and to the consolidated law', () => {
    renderAt('/metodo');
    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(`${REPO}/blob/main/docs/LEGAL-SOURCES.md`);
    expect(hrefs).toContain(
      'https://www.boe.es/buscar/act.php?id=BOE-A-2004-21830',
    );
  });

  it('shows the worked example with the first segment of the home page', () => {
    renderAt('/metodo');
    const worked = document.querySelector('.worked')?.textContent ?? '';
    expect(worked).toContain(
      `8.940,00${NBSP}€ × 10,15${NBSP}% × 110 ÷ 365 = 273,47${NBSP}€`,
    );
  });
});

describe('Privacy', () => {
  it('says plainly that there is one session cookie and no third-party requests', () => {
    renderAt('/privacidad');
    const text = screen.getByRole('main').textContent;
    expect(text).toContain('una única cookie, la de sesión');
    expect(text).toContain('Estados Unidos');
    expect(text).toContain('24 horas');
  });
});
