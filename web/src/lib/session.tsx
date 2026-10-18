// Who is signed in. The session itself is an HttpOnly cookie that the browser sends and only the
// server can read, so this state holds what GET /api/me answered and nothing that could be a token.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, onSessionExpired } from './api.ts';

export interface SessionUser {
  id: string;
  // A demo user has no email.
  email: string | null;
  is_demo: boolean;
}

export type Compensation = 'NONE' | 'PER_INVOICE' | 'PER_CLAIM';

export interface Profile {
  business_name: string | null;
  tax_id: string | null;
  address: string | null;
  iban: string | null;
  default_compensation: Compensation;
}

type State =
  | { status: 'loading' }
  // `left`: the person ended the session on purpose (Salir, account deleted), as opposed to it
  // expiring. A protected page sends the first to the home page and the second to the login.
  | { status: 'anonymous'; left?: boolean }
  // GET /api/me could not be answered (network, 5xx): we do not know whether there is a session.
  | { status: 'unavailable' }
  | { status: 'authenticated'; user: SessionUser; profile: Profile | null };

export interface SessionValue {
  status: State['status'];
  // true after a deliberate sign-out; see State.
  left: boolean;
  user: SessionUser | null;
  profile: Profile | null;
  // Asks the server again. true when it confirmed a signed-in user.
  refresh: () => Promise<boolean>;
  // true when the user is signed out (also when the session was already gone).
  signOut: () => Promise<boolean>;
  // Drops the local state without calling the server, for when the server already ended the
  // session (account deleted).
  forget: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  // Answers can arrive out of order (React StrictMode runs the first load twice; a sign-out can
  // overtake a refresh). Only the answer to the latest request may change the state.
  const latest = useRef(0);

  const refresh = useCallback((): Promise<boolean> => {
    const mine = ++latest.current;
    return api<{ user: SessionUser; profile: Profile | null }>(
      'GET',
      '/api/me',
    ).then((result) => {
      if (mine !== latest.current) return result.ok;
      if (result.ok) {
        setState({
          status: 'authenticated',
          user: result.data.user,
          profile: result.data.profile,
        });
      } else if (result.kind === 'unauthenticated') {
        setState({ status: 'anonymous' });
      } else {
        // A hiccup must not make a signed-in person look signed out.
        setState((previous) =>
          previous.status === 'authenticated'
            ? previous
            : { status: 'unavailable' },
        );
      }
      return result.ok;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any later call that finds the session gone (expired, ended elsewhere) lands here.
  useEffect(
    () =>
      onSessionExpired(() => {
        latest.current++;
        setState({ status: 'anonymous' });
      }),
    [],
  );

  const signOut = useCallback(async () => {
    const result = await api('POST', '/api/auth/logout');
    // A dead network or a server error means the cookie may still be valid: do not pretend.
    if (!result.ok && result.kind !== 'unauthenticated') return false;
    latest.current++;
    setState({ status: 'anonymous', left: true });
    return true;
  }, []);

  const forget = useCallback(() => {
    latest.current++;
    setState({ status: 'anonymous', left: true });
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status: state.status,
      left: state.status === 'anonymous' && state.left === true,
      user: state.status === 'authenticated' ? state.user : null,
      profile: state.status === 'authenticated' ? state.profile : null,
      refresh,
      signOut,
      forget,
    }),
    [state, refresh, signOut, forget],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession needs a SessionProvider');
  return value;
}
