import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';
import { Home } from './pages/Home.tsx';
import { Method } from './pages/Method.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Privacy } from './pages/Privacy.tsx';

// The screens that do not exist yet already have their real route: building one means replacing
// its element.
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'metodo', element: <Method /> },
      { path: 'privacidad', element: <Privacy /> },
      { path: 'entrar', element: <ComingSoon screen="Entrar" /> },
      { path: 'registro', element: <ComingSoon screen="Crear cuenta" /> },
      { path: 'demo', element: <ComingSoon screen="Demo" /> },
      { path: 'panel', element: <ComingSoon screen="Panel" /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
