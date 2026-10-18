import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type Failure } from '../lib/api.ts';
import { useBusy } from '../lib/forms.ts';
import { failureMessage, NETWORK_MESSAGE } from '../lib/messages.ts';
import { useSession } from '../lib/session.tsx';

function demoMessage(failure: Failure): string {
  if (failure.code === 'DEMO_FULL') {
    return 'La demo está llena ahora mismo. Inténtalo en unos minutos o crea una cuenta.';
  }
  if (failure.code === 'DEMO_UNAVAILABLE') {
    return 'La demo no está disponible ahora mismo.';
  }
  return failureMessage(failure);
}

// Each visit to the API creates a sandbox with data, so it starts from a button and never on
// load: a crawler, a prefetch or the back button must not fill the database.
export function Demo() {
  const navigate = useNavigate();
  const { status, refresh } = useSession();
  const { busy, run } = useBusy();
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const alert = useRef<HTMLDivElement>(null);

  function start() {
    void run(async () => {
      setError(null);
      const result = await api('POST', '/api/demo/session');
      if (!result.ok) {
        setError(demoMessage(result));
        // A dead connection or a server error is worth another try right away; "full", "not
        // available" and the rate limit say to wait.
        setRetry(
          result.code !== 'DEMO_FULL' &&
            result.code !== 'DEMO_UNAVAILABLE' &&
            ['network', 'server', 'unavailable'].includes(result.kind),
        );
        alert.current?.focus();
        return;
      }
      if (!(await refresh())) {
        setError(NETWORK_MESSAGE);
        setRetry(true);
        alert.current?.focus();
        return;
      }
      void navigate('/panel', { replace: true });
    });
  }

  return (
    <div className="wrap form-page">
      <title>Probar la demo · Reclama</title>
      <h1>Probar la demo</h1>
      <p className="lede">
        Entras en un espacio con facturas ficticias ya cargadas, sin
        registrarte. Los datos se borran a las 24 horas.
      </p>
      <div role="alert" className="form-alert" tabIndex={-1} ref={alert}>
        {error ? <p>{error}</p> : null}
      </div>
      {status === 'authenticated' ? (
        <p>
          Ya tienes una sesión abierta.{' '}
          <Link to="/panel">Ir a mis facturas</Link>
        </p>
      ) : (
        <p>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            aria-busy={busy}
            onClick={start}
          >
            {busy
              ? 'Preparando la demo…'
              : retry
                ? 'Reintentar'
                : 'Empezar la demo'}
          </button>
        </p>
      )}
      <p className="form-alt">
        ¿Prefieres tus propios datos?{' '}
        <Link to="/registro">Crea una cuenta</Link>.
      </p>
    </div>
  );
}
