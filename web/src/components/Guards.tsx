import { useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { rememberedPath } from '../lib/forms.ts';
import { NETWORK_MESSAGE } from '../lib/messages.ts';
import { useSession } from '../lib/session.tsx';

function Loading() {
  return (
    <div className="wrap prose">
      <p role="status">Cargando…</p>
    </div>
  );
}

// GET /api/me could not be answered, so we do not know whether there is a session: say so and
// let the person try again, instead of sending them to a login that would fail too.
function SessionUnavailable() {
  const { refresh } = useSession();
  const [trying, setTrying] = useState(false);
  return (
    <div className="wrap prose">
      <title>Sin conexión · Reclama</title>
      <h1>No hemos podido comprobar tu sesión</h1>
      <p role="alert">{NETWORK_MESSAGE}</p>
      <button
        type="button"
        className="btn primary"
        disabled={trying}
        onClick={() => {
          setTrying(true);
          void refresh().finally(() => {
            setTrying(false);
          });
        }}
      >
        Reintentar
      </button>
    </div>
  );
}

// Routes that need a signed-in user. The page asked for is remembered in the router state (not in
// the URL, where it would end up in logs and the Referer) so the login can bring the person back.
export function RequireAuth() {
  const { status, left } = useSession();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'unavailable') return <SessionUnavailable />;
  if (status === 'anonymous' && left) return <Navigate to="/" replace />;
  if (status === 'anonymous') {
    return (
      <Navigate
        to="/entrar"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <Outlet />;
}

// /entrar and /registro: someone already signed in has nothing to do there. The form is drawn
// while the session is still loading (most visitors are anonymous and should not wait for the
// answer to see it). A demo user may stay: they have a reason to sign in or create a real account.
export function RedirectIfAuth() {
  const { status, user } = useSession();
  const location = useLocation();
  if (status === 'authenticated' && !user?.is_demo) {
    return <Navigate to={rememberedPath(location.state) ?? '/panel'} replace />;
  }
  return <Outlet />;
}
