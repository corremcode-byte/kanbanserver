/**
 * Route-level authorization wiring for the permission-sensitive routers.
 *
 * These tests assert which middleware is actually mounted on each route, so a
 * route that silently loses its permission guard fails here. Every middleware
 * and controller is stubbed with an identifiable marker; the routers are then
 * imported and their Express stacks inspected. This is deliberately narrow —
 * the full route audit is a later batch.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requireManagerOrAdmin: Object.assign(jest.fn(), { mwName: 'requireManagerOrAdmin' }),
  requireAdmin: Object.assign(jest.fn(), { mwName: 'requireAdmin' }),
  requireSuperAdmin: Object.assign(jest.fn(), { mwName: 'requireSuperAdmin' }),
}));

jest.mock('../../middleware/permissions', () => ({
  // checkPermission is a factory: tag the returned middleware with its permission.
  checkPermission: jest.fn((permission: string) =>
    Object.assign(jest.fn(), { mwName: `checkPermission(${permission})` })
  ),
  checkCanCreateProject: Object.assign(jest.fn(), { mwName: 'checkCanCreateProject' }),
  checkCanDeleteProject: Object.assign(jest.fn(), { mwName: 'checkCanDeleteProject' }),
  checkCanEditTask: Object.assign(jest.fn(), { mwName: 'checkCanEditTask' }),
  checkCanDeleteTask: Object.assign(jest.fn(), { mwName: 'checkCanDeleteTask' }),
  checkTaskAccess: Object.assign(jest.fn(), { mwName: 'checkTaskAccess' }),
}));

jest.mock('../../controllers/projectsController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `projects.${prop}` }),
}));

jest.mock('../../controllers/permissionsController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `permissions.${prop}` }),
}));

import projectsRouter from '../projects';
import permissionsRouter from '../permissions';

/** Names of the handlers mounted on a given method+path of a router. */
function handlersFor(router: any, method: string, path: string): string[] {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  );
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s: any) => s.handle.mwName ?? s.handle.name ?? 'anonymous');
}

/** Router-level middleware mounted via router.use(...). */
function routerLevelMiddleware(router: any): string[] {
  return router.stack
    .filter((l: any) => !l.route)
    .map((l: any) => l.handle.mwName ?? l.handle.name ?? 'anonymous');
}

function routePaths(router: any): Array<{ method: string; path: string }> {
  return router.stack
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path }))
    );
}

describe('projects router — authentication', () => {
  it('applies authenticate to every route via router-level middleware', () => {
    expect(routerLevelMiddleware(projectsRouter)).toContain('authenticate');
  });

  it('mounts no route that bypasses the router-level authenticate', () => {
    // Every project route is registered after router.use(authenticate), so none
    // of them may carry optionalAuth or no auth at all.
    for (const { method, path } of routePaths(projectsRouter)) {
      expect(handlersFor(projectsRouter, method, path)).not.toContain('optionalAuth');
    }
  });
});

describe('projects router — permission middleware wiring', () => {
  it('guards project creation with checkCanCreateProject', () => {
    expect(handlersFor(projectsRouter, 'post', '/')).toEqual([
      'checkCanCreateProject',
      'projects.createProject',
    ]);
  });

  it('guards project update with checkPermission(canEditProject)', () => {
    expect(handlersFor(projectsRouter, 'put', '/:id')).toEqual([
      'checkPermission(canEditProject)',
      'projects.updateProject',
    ]);
  });

  it('guards project deletion with checkCanDeleteProject', () => {
    expect(handlersFor(projectsRouter, 'delete', '/:id')).toEqual([
      'checkCanDeleteProject',
      'projects.deleteProject',
    ]);
  });

  it('guards all three member-management routes with checkPermission(canManageMembers)', () => {
    expect(handlersFor(projectsRouter, 'post', '/:id/members')).toContain(
      'checkPermission(canManageMembers)'
    );
    expect(handlersFor(projectsRouter, 'delete', '/:id/members/:userId')).toContain(
      'checkPermission(canManageMembers)'
    );
    expect(handlersFor(projectsRouter, 'put', '/:id/members/:userId/role')).toContain(
      'checkPermission(canManageMembers)'
    );
  });

  it('uses the :id route parameter that checkPermission actually reads', () => {
    // checkPermission resolves req.params.projectId || req.params.id, so the
    // guarded project routes must name the parameter one of those two.
    for (const { method, path } of routePaths(projectsRouter)) {
      const handlers = handlersFor(projectsRouter, method, path);
      const guarded = handlers.some((h) => h.startsWith('checkPermission('));
      if (guarded) {
        expect(path.startsWith('/:id')).toBe(true);
      }
    }
  });

  // FINDING (documented, not fixed): owner management, leaving a project and
  // list management carry no permission middleware at all — they are protected
  // only by whatever the controller checks. addList/updateList/deleteList rely
  // on isProjectManager, which treats any manager or any co-owner (including a
  // 'view' co-owner) as authorised.
  it('leaves owner-management and list routes without any permission middleware', () => {
    const unguarded = [
      ['put', '/:id/owners/:userId'],
      ['delete', '/:id/owners/:userId'],
      ['post', '/:id/transfer-ownership'],
      ['delete', '/:id/leave'],
      ['post', '/:id/lists'],
      ['put', '/:id/lists/:listId'],
      ['delete', '/:id/lists/:listId'],
      ['put', '/:id/lists/reorder'],
    ];

    for (const [method, path] of unguarded) {
      const handlers = handlersFor(projectsRouter, method, path);
      expect(handlers.some((h) => h.startsWith('checkPermission('))).toBe(false);
      expect(handlers).toHaveLength(1); // controller only
    }
  });

  it('registers the lists reorder route before the parameterised list route', () => {
    // Otherwise "/:id/lists/reorder" would be captured by "/:id/lists/:listId".
    const paths = routePaths(projectsRouter).map((r) => r.path);
    expect(paths.indexOf('/:id/lists/reorder')).toBeLessThan(paths.indexOf('/:id/lists/:listId'));
  });

  it('leaves project read routes to controller-level access checks', () => {
    expect(handlersFor(projectsRouter, 'get', '/')).toEqual(['projects.getProjects']);
    expect(handlersFor(projectsRouter, 'get', '/:id')).toEqual(['projects.getProject']);
  });
});

describe('permissions router — wiring', () => {
  it('applies authenticate to every permissions route', () => {
    expect(routerLevelMiddleware(permissionsRouter)).toContain('authenticate');
  });

  // FINDING (documented, not fixed): none of the permission-management routes
  // carries permission middleware. Authorization is entirely controller-side,
  // and getUserPermission performs no check at all — so this route is
  // effectively open to any authenticated user.
  it('mounts every permissions route with the controller as its only handler', () => {
    const routes: Array<[string, string]> = [
      ['get', '/project/:projectId/me'],
      ['get', '/project/:projectId'],
      ['get', '/project/:projectId/user/:userId'],
      ['put', '/project/:projectId/user/:userId'],
      ['delete', '/project/:projectId/user/:userId'],
    ];

    for (const [method, path] of routes) {
      expect(handlersFor(permissionsRouter, method, path)).toHaveLength(1);
    }
  });

  it('registers the /me route before the broader project route', () => {
    const paths = routePaths(permissionsRouter).map((r) => r.path);
    expect(paths.indexOf('/project/:projectId/me')).toBeLessThan(
      paths.indexOf('/project/:projectId')
    );
  });

  it('routes read, update and delete of a user permission to distinct handlers', () => {
    expect(handlersFor(permissionsRouter, 'get', '/project/:projectId/user/:userId')).toEqual([
      'permissions.getUserPermission',
    ]);
    expect(handlersFor(permissionsRouter, 'put', '/project/:projectId/user/:userId')).toEqual([
      'permissions.updateUserPermission',
    ]);
    expect(handlersFor(permissionsRouter, 'delete', '/project/:projectId/user/:userId')).toEqual([
      'permissions.deleteUserPermission',
    ]);
  });
});
