import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { RedirectIfAuth, RequireAuth } from './components/Guards.tsx';
import { SessionProvider } from './lib/session.tsx';
import { Login, Register } from './pages/Auth.tsx';
import { ClaimDetailPage } from './pages/ClaimDetailPage.tsx';
import { ClaimList } from './pages/ClaimList.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Demo } from './pages/Demo.tsx';
import { Home } from './pages/Home.tsx';
import { ImportCsv } from './pages/ImportCsv.tsx';
import { InvoiceDetail } from './pages/InvoiceDetail.tsx';
import { Method } from './pages/Method.tsx';
import { NewClaim } from './pages/NewClaim.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { Profile } from './pages/Profile.tsx';

// The session provider is the root route's element, inside the router, so a page and its tests
// never need to wrap anything by hand.
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
          { path: 'importar', element: <ImportCsv /> },
          { path: 'reclamaciones', element: <ClaimList /> },
          { path: 'reclamaciones/nueva', element: <NewClaim /> },
          { path: 'reclamaciones/:id', element: <ClaimDetailPage /> },
          { path: 'perfil', element: <Profile /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];
