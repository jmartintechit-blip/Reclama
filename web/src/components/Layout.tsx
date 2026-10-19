import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useSession } from '../lib/session.tsx';

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
  const { status, user, signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const inInvoices =
    pathname.startsWith('/panel') || pathname.startsWith('/facturas');
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

  // Once the session is cleared, a protected page sends the visitor home by itself (RequireAuth)
  // and a public one stays where it is: nothing to navigate here.
  async function leave() {
    setSigningOut(true);
    setSignOutFailed(false);
    const done = await signOut();
    setSigningOut(false);
    setSignOutFailed(!done);
  }

  return (
    <>
      <a className="skip" href="#contenido">
        Saltar al contenido
      </a>
      <header className="bar">
        <div className="wrap">
          <Logo />
          <nav aria-label="Principal" aria-busy={status === 'loading'}>
            {status === 'authenticated' ? (
              <>
                {/* The invoice detail belongs to this section, which a plain NavLink would not highlight. */}
                <Link
                  to="/panel"
                  aria-current={inInvoices ? 'page' : undefined}
                >
                  Facturas
                </Link>
                <NavLink to="/importar">Importar</NavLink>
                <NavLink to="/reclamaciones">Reclamaciones</NavLink>
                <NavLink to="/perfil">Perfil</NavLink>
                <button
                  type="button"
                  className="btn small"
                  disabled={signingOut}
                  onClick={() => void leave()}
                >
                  Salir
                </button>
              </>
            ) : (
              <>
                <NavLink to="/metodo">Método</NavLink>
                <NavLink to="/privacidad">Privacidad</NavLink>
                {/* While the session loads, no button: it could be the wrong one. */}
                {status === 'loading' ? null : (
                  <Link className="btn small" to="/entrar">
                    Entrar
                  </Link>
                )}
              </>
            )}
          </nav>
        </div>
      </header>
      {user?.is_demo ? (
        <div className="banner">
          <div className="wrap">
            <p>
              Modo demo: los datos son ficticios y se borran a las 24 horas.
            </p>
            <Link to="/registro">Crear mi cuenta</Link>
          </div>
        </div>
      ) : null}
      <div role="alert">
        {signOutFailed ? (
          <div className="banner error">
            <div className="wrap">
              <p>No hemos podido cerrar la sesión. Inténtalo de nuevo.</p>
            </div>
          </div>
        ) : null}
      </div>
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
