import { useRef, useState, type SubmitEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ErrorSummary, TextField } from '../components/Field.tsx';
import { api, type Failure } from '../lib/api.ts';
import {
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
  errorsFromFailure,
  NO_ERRORS,
  rememberedPath,
  useBusy,
  useFocusOnErrors,
  withFieldErrors,
  type FormErrors,
} from '../lib/forms.ts';
import {
  EMAIL_INVALID_MESSAGE,
  NETWORK_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from '../lib/messages.ts';
import { useSession } from '../lib/session.tsx';

type Mode = 'login' | 'register';

// The server decides; this rule (and the email one in lib/forms.ts) is copied only to tell the person
// at once, without a round trip, about the commonest mistakes: 10 to 128 characters (code points)
// for a new password.
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

const LABELS = { email: 'Email', password: 'Contraseña' };
const FIELDS = ['email', 'password'] as const;

function checkLocally(mode: Mode, email: string, password: string) {
  const fields: Record<string, string> = {};
  const normalized = email.trim().toLowerCase();
  if (normalized === '') {
    fields.email = 'Escribe tu email.';
  } else if (
    normalized.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    fields.email = EMAIL_INVALID_MESSAGE;
  }
  if (mode === 'login') {
    if (password === '') fields.password = 'Escribe tu contraseña.';
  } else {
    const length = Array.from(password).length;
    if (length < PASSWORD_MIN_LENGTH) {
      fields.password = PASSWORD_TOO_SHORT_MESSAGE;
    } else if (length > PASSWORD_MAX_LENGTH) {
      fields.password = PASSWORD_TOO_LONG_MESSAGE;
    }
  }
  return fields;
}

function serverErrors(mode: Mode, failure: Failure): FormErrors {
  if (failure.code === 'INVALID_CREDENTIALS') {
    return {
      summary: 'El email o la contraseña no son correctos.',
      fields: {},
    };
  }
  if (failure.code === 'EMAIL_TAKEN') {
    return withFieldErrors({
      email: 'Ya hay una cuenta con ese email. Entra o usa otro.',
    });
  }
  const errors = errorsFromFailure(failure, FIELDS);
  // Entering does not teach the rules of a password: a login that the server refuses for the
  // password's shape is just a wrong password.
  if (mode === 'login' && errors.fields.password) {
    errors.fields.password = 'La contraseña no es correcta.';
  }
  return errors;
}

function AuthForm({ mode }: { mode: Mode }) {
  const isLogin = mode === 'login';
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh, user } = useSession();
  const { busy, run } = useBusy();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const form = useRef<HTMLFormElement>(null);
  useFocusOnErrors(errors, form);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const fields = checkLocally(mode, email, password);
      if (Object.keys(fields).length > 0) {
        setErrors(withFieldErrors(fields));
        return;
      }
      setErrors(NO_ERRORS);
      const result = await api(
        'POST',
        isLogin ? '/api/auth/login' : '/api/auth/register',
        { email: email.trim(), password },
      );
      if (!result.ok) {
        setErrors(serverErrors(mode, result));
        return;
      }
      // The cookie is already set; load the user it belongs to before leaving.
      if (!(await refresh())) {
        setErrors({ summary: NETWORK_MESSAGE, fields: {} });
        return;
      }
      void navigate(rememberedPath(location.state) ?? '/panel', {
        replace: true,
      });
    });
  }

  return (
    <div className="wrap form-page">
      {/* One string: React only accepts a single text child in <title>. */}
      <title>{`${isLogin ? 'Entrar' : 'Crear cuenta'} · Reclama`}</title>
      <h1>{isLogin ? 'Entrar' : 'Crear cuenta'}</h1>
      {!isLogin && user?.is_demo ? (
        <p className="lede">
          Si vienes de la demo, la cuenta nueva empieza sin datos: los de la
          demo no se copian.
        </p>
      ) : null}
      <form
        ref={form}
        className="sheet form"
        noValidate
        aria-busy={busy}
        onSubmit={submit}
      >
        <ErrorSummary errors={errors} labels={LABELS} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          error={errors.fields.email}
        />
        <TextField
          label="Contraseña"
          name="password"
          type={show ? 'text' : 'password'}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
          hint={isLogin ? undefined : 'Mínimo 10 caracteres'}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={errors.fields.password}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={show}
            onChange={(event) => {
              setShow(event.target.checked);
            }}
          />
          Mostrar contraseña
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy
            ? isLogin
              ? 'Entrando…'
              : 'Creando la cuenta…'
            : isLogin
              ? 'Entrar'
              : 'Crear cuenta'}
        </button>
      </form>
      <p className="form-alt">
        {isLogin ? (
          <>
            ¿No tienes cuenta? <Link to="/registro">Crea una</Link> o{' '}
            <Link to="/demo">prueba la demo</Link>.
          </>
        ) : (
          <>
            ¿Ya tienes cuenta? <Link to="/entrar">Entra</Link>.
          </>
        )}
      </p>
    </div>
  );
}

export function Login() {
  return <AuthForm mode="login" />;
}

export function Register() {
  return <AuthForm mode="register" />;
}
