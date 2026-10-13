import type { DefineRoute } from '../http/routes.ts';

export function registerMeRoutes(defineRoute: DefineRoute) {
  defineRoute({
    method: 'GET',
    path: '/api/me',
    handler: ({ res, session }) => {
      const { id, email, is_demo } = session.user;
      res.json({ data: { user: { id, email, is_demo } } });
    },
  });
}
