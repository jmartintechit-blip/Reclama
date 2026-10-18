import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

export const REPO_URL = 'https://github.com/jmartintechit-blip/Reclama';

function Logo() {
  return (
    <Link className="brand" to="/" aria-label="Reclama, inicio">
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path className="brand-mark" d="M3 25h7v-7h7v-7h7V6h5" />
      </svg>
      Reclama
    </Link>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // A route change does not reload the page, so keyboard and screen reader users would stay
  // where the old link was. Moving focus to <main> announces the new page and restarts Tab there.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);

  return (
    <>
      <a className="skip" href="#contenido">
        Saltar al contenido
      </a>
      <header className="bar">
        <div className="wrap">
          <Logo />
          <nav aria-label="Principal">
            <NavLink to="/metodo">Método</NavLink>
            <NavLink to="/privacidad">Privacidad</NavLink>
            <Link className="btn small" to="/entrar">
              Entrar
            </Link>
          </nav>
        </div>
      </header>
      <main id="contenido" ref={main} tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="foot">
        <div className="wrap">
          <p>
            Reclama es una herramienta informativa de ayuda al cobro, no
            asesoramiento jurídico.
          </p>
          <p>
            <a href={REPO_URL}>Código en GitHub</a>
            <span>Fuente de los tipos de interés: BOE.</span>
          </p>
        </div>
      </footer>
    </>
  );
}
