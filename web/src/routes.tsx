import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { RedirectIfAuth, RequireAuth } from './components/Guards.tsx';
import { SessionProvider } from './lib/session.tsx';
import { Login, Register } from './pages/Auth.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Demo } from './pages/Demo.tsx';
import { Home } from './pages/Home.tsx';
import { InvoiceDetail } from './pages/InvoiceDetail.tsx';
import { Method } from './pages/Method.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { Profile } from './pages/Profile.tsx';

// The screens that do not exist yet already have their real route: building one means replacing
// its element. The session provider is the root route's element, inside the router, so a page
// and its tests never need to wrap anything by hand.
export const routes: RouteObject[] = [
  {
    element: (
      <SessionProvider>
        <Layout />
      </SessionProvider>
    ),
    children: [
      { index: true, element: <Home /> },
      { path: 'metodo', element: <Method /> },
      { path: 'privacidad', element: <Privacy /> },
      { path: 'demo', element: <Demo /> },
      {
        element: <RedirectIfAuth />,
        children: [
          { path: 'entrar', element: <Login /> },
          { path: 'registro', element: <Register /> },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: 'panel', element: <Dashboard /> },
          { path: 'facturas/:id', element: <InvoiceDetail /> },
          { path: 'importar', element: <ComingSoon screen="Importar" /> },
          {
            path: 'reclamaciones',
            element: <ComingSoon screen="Reclamaciones" />,
          },
          {
            path: 'reclamaciones/nueva',
            element: <ComingSoon screen="Nueva reclamación" />,
          },
          { path: 'perfil', element: <Profile /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];
