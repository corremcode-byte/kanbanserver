/**
 * Route authorization wiring for the data-access areas: audit, notifications,
 * support, search and user/module-data.
 *
 * Same router-stack inspection pattern as Batch 3/5 — no supertest. These lock
 * the CURRENT wiring so that adding or removing a guard is a visible change.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requireAdmin: Object.assign(jest.fn(), { mwName: 'requireAdmin' }),
  requireSuperAdmin: Object.assign(jest.fn(), { mwName: 'requireSuperAdmin' }),
  requireManagerOrAdmin: Object.assign(jest.fn(), { mwName: 'requireManagerOrAdmin' }),
  requireActiveUser: Object.assign(jest.fn(), { mwName: 'requireActiveUser' }),
  requireEmailVerified: Object.assign(jest.fn(), { mwName: 'requireEmailVerified' }),
}));

jest.mock('../../middleware/permissions', () => ({
  checkPermission: jest.fn((p: string) => Object.assign(jest.fn(), { mwName: `checkPermission(${p})` })),
  checkCanCreateProject: Object.assign(jest.fn(), { mwName: 'checkCanCreateProject' }),
  checkCanDeleteProject: Object.assign(jest.fn(), { mwName: 'checkCanDeleteProject' }),
  checkCanEditTask: Object.assign(jest.fn(), { mwName: 'checkCanEditTask' }),
  checkCanDeleteTask: Object.assign(jest.fn(), { mwName: 'checkCanDeleteTask' }),
}));

const controllerProxy = (prefix: string) =>
  new Proxy({}, { get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `${prefix}.${prop}` }) });

jest.mock('../../controllers/auditController', () => controllerProxy('audit'));
jest.mock('../../controllers/notificationController', () => controllerProxy('notif'));
jest.mock('../../controllers/supportController', () => controllerProxy('support'));
jest.mock('../../controllers/searchController', () => controllerProxy('search'));
jest.mock('../../controllers/userController', () => controllerProxy('user'));
jest.mock('../../controllers/superAdminController', () => controllerProxy('superAdmin'));

import auditRouter from '../audit';
import notificationsRouter from '../notifications';
import supportRouter from '../support';
import searchRouter from '../search';
import userRouter from '../user';

function handlersFor(router: any, method: string, path: string): string[] {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  );
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s: any) => s.handle.mwName ?? s.handle.name ?? 'anonymous');
}

function routerLevelMiddleware(router: any): string[] {
  return router.stack.filter((l: any) => !l.route).map((l: any) => l.handle?.mwName ?? 'anonymous');
}

function allRoutes(router: any): Array<{ method: string; path: string }> {
  return router.stack
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path }))
    );
}

/** Every middleware name appearing anywhere on a router. */
function allMiddleware(router: any): string[] {
  return router.stack.flatMap((l: any) =>
    l.route ? l.route.stack.map((s: any) => s.handle.mwName) : [l.handle?.mwName]
  );
}

const PERMISSION_GUARDS = [
  'checkCanCreateProject',
  'checkCanDeleteProject',
  'checkCanEditTask',
  'checkCanDeleteTask',
];

function hasPermissionMiddleware(handlers: string[]): boolean {
  return handlers.some((h) => h.startsWith('checkPermission(') || PERMISSION_GUARDS.includes(h));
}

describe('audit router', () => {
  it('applies authenticate to every audit route', () => {
    expect(routerLevelMiddleware(auditRouter)).toContain('authenticate');
  });

  it('guards cleanup and delete-all with requireAdmin', () => {
    expect(handlersFor(auditRouter, 'post', '/cleanup')).toEqual([
      'requireAdmin',
      'audit.cleanupDeletedUsers',
    ]);
    expect(handlersFor(auditRouter, 'delete', '/')).toEqual([
      'requireAdmin',
      'audit.deleteAllAuditLogs',
    ]);
  });

  // FINDING (documented, NOT fixed): reading the audit log is protected only by
  // authenticate — no role gate and no project-permission middleware — and the
  // controller adds no scoping of its own (see auditController.test.ts).
  it('leaves audit log READING on authenticate alone, with no role or permission gate', () => {
    const handlers = handlersFor(auditRouter, 'get', '/');

    expect(handlers).toEqual(['audit.getAuditLogs']);
    expect(handlers).not.toContain('requireAdmin');
    expect(hasPermissionMiddleware(handlers)).toBe(false);
  });

  it('mounts no project-permission middleware anywhere on the audit router', () => {
    expect(allMiddleware(auditRouter).filter((m) => m?.startsWith('checkPermission('))).toEqual([]);
  });
});

describe('notifications router', () => {
  it('applies authenticate to every notification route', () => {
    expect(routerLevelMiddleware(notificationsRouter)).toContain('authenticate');
  });

  it('mounts every route with the controller as its only handler', () => {
    for (const { method, path } of allRoutes(notificationsRouter)) {
      expect(handlersFor(notificationsRouter, method, path)).toHaveLength(1);
    }
  });

  it('registers the fixed mark-all-read path and the parameterised read path distinctly', () => {
    expect(handlersFor(notificationsRouter, 'patch', '/mark-all-read')).toEqual([
      'notif.markAllNotificationsAsRead',
    ]);
    expect(handlersFor(notificationsRouter, 'patch', '/:notificationId/read')).toEqual([
      'notif.markNotificationAsRead',
    ]);
  });

  it('routes delete of a notification to its own handler', () => {
    expect(handlersFor(notificationsRouter, 'delete', '/:notificationId')).toEqual([
      'notif.deleteNotification',
    ]);
  });

  // The task-scoped endpoints have no project-permission middleware; the
  // controller performs no membership check either.
  it('leaves the task-scoped notification routes on authenticate alone', () => {
    for (const [method, path] of [
      ['get', '/stats/task/:taskId'],
      ['get', '/details/task/:taskId'],
    ] as Array<[string, string]>) {
      const handlers = handlersFor(notificationsRouter, method, path);
      expect(handlers).toHaveLength(1);
      expect(hasPermissionMiddleware(handlers)).toBe(false);
    }
  });

  it('mounts no role middleware anywhere on the notifications router', () => {
    const mounted = allMiddleware(notificationsRouter);
    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireSuperAdmin');
    expect(mounted).not.toContain('requireManagerOrAdmin');
  });
});

describe('support router', () => {
  it('applies authenticate to every support route', () => {
    expect(routerLevelMiddleware(supportRouter)).toContain('authenticate');
  });

  // FINDING (documented, NOT fixed): listing and reading tickets carry no role
  // or ownership middleware, and the controller adds none either.
  it('leaves ticket listing and reading on authenticate alone', () => {
    expect(handlersFor(supportRouter, 'get', '/tickets')).toEqual(['support.getAllTickets']);
    expect(handlersFor(supportRouter, 'get', '/tickets/:id')).toEqual(['support.getTicket']);
  });

  it('mounts every support route with a single handler and no role gate', () => {
    for (const { method, path } of allRoutes(supportRouter)) {
      expect(handlersFor(supportRouter, method, path)).toHaveLength(1);
    }
    const mounted = allMiddleware(supportRouter);
    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireManagerOrAdmin');
  });

  it('exposes exactly the five documented ticket routes', () => {
    expect(allRoutes(supportRouter).map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'get /tickets',
        'get /tickets/:id',
        'patch /tickets/:id/status',
        'post /tickets',
        'post /tickets/:id/replies',
      ].sort()
    );
  });
});

describe('search router', () => {
  it('guards the search route with authenticate at route level', () => {
    expect(handlersFor(searchRouter, 'get', '/')).toEqual(['authenticate', 'search.search']);
  });

  it('exposes no unauthenticated search route', () => {
    for (const { method, path } of allRoutes(searchRouter)) {
      expect(handlersFor(searchRouter, method, path)).toContain('authenticate');
    }
  });
});

describe('user router — module-data and admin-style routes', () => {
  it('applies authenticate to every user route', () => {
    expect(routerLevelMiddleware(userRouter)).toContain('authenticate');
  });

  // FINDING (documented, NOT fixed): this route is commented
  // "Super admin — module data for a specific user" and its handler lives in
  // superAdminController, yet it carries no requireSuperAdmin middleware and
  // the controller performs no role check (see superAdminModuleData.test.ts).
  it('mounts the super-admin module-data route without any super-admin gate', () => {
    const handlers = handlersFor(userRouter, 'get', '/:userId/module-data');

    expect(handlers).toEqual(['superAdmin.getAdminUserModuleData']);
    expect(handlers).not.toContain('requireSuperAdmin');
    expect(handlers).not.toContain('requireAdmin');
  });

  it('mounts no role middleware at all on the user router, admin routes included', () => {
    const mounted = allMiddleware(userRouter);

    expect(mounted).not.toContain('requireSuperAdmin');
    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireManagerOrAdmin');
  });

  it('leaves the permission-management routes on authenticate alone', () => {
    // Documented: these are labelled "Admin routes for user management" in the
    // source but rely entirely on controller-side checks.
    for (const [method, path] of [
      ['get', '/:userId/permissions'],
      ['put', '/:userId/permissions'],
      ['put', '/bulk/permissions'],
      ['put', '/:userId/role'],
      ['put', '/:userId/toggle-active'],
    ] as Array<[string, string]>) {
      expect(handlersFor(userRouter, method, path)).toHaveLength(1);
    }
  });

  it('leaves the passkey read/write routes on authenticate alone', () => {
    expect(handlersFor(userRouter, 'get', '/:userId/passkey')).toEqual(['user.getUserPasskey']);
    expect(handlersFor(userRouter, 'put', '/:userId/passkey')).toEqual(['user.updateUserPasskey']);
  });

  it('registers the fixed delete-all path before the parameterised delete route', () => {
    const paths = allRoutes(userRouter).map((r) => r.path);
    expect(paths.indexOf('/delete-all')).toBeLessThan(paths.indexOf('/:userId'));
  });

  it('registers /search and /all before the parameterised :userId routes', () => {
    const paths = allRoutes(userRouter).map((r) => r.path);
    const firstParam = paths.findIndex((p) => p.startsWith('/:userId'));
    expect(paths.indexOf('/search')).toBeLessThan(firstParam);
    expect(paths.indexOf('/all')).toBeLessThan(firstParam);
  });
});

describe('cross-router summary of data-access protections', () => {
  it('protects all five routers with authenticate and nothing stronger by default', () => {
    const routers: Array<[string, any]> = [
      ['audit', auditRouter],
      ['notifications', notificationsRouter],
      ['support', supportRouter],
      ['user', userRouter],
    ];

    for (const [, router] of routers) {
      expect(routerLevelMiddleware(router)).toContain('authenticate');
    }
    // search applies authenticate per-route rather than router-wide.
    expect(handlersFor(searchRouter, 'get', '/')).toContain('authenticate');
  });

  it('mounts requireAdmin on exactly two routes across all five routers', () => {
    const adminGuarded = [auditRouter, notificationsRouter, supportRouter, searchRouter, userRouter]
      .flatMap((r) => allMiddleware(r))
      .filter((m) => m === 'requireAdmin');

    expect(adminGuarded).toHaveLength(2); // audit cleanup + audit delete-all
  });

  it('mounts no project-permission middleware on any of these routers', () => {
    const permissionGuards = [
      auditRouter,
      notificationsRouter,
      supportRouter,
      searchRouter,
      userRouter,
    ]
      .flatMap((r) => allMiddleware(r))
      .filter((m) => m && (m.startsWith('checkPermission(') || PERMISSION_GUARDS.includes(m)));

    expect(permissionGuards).toEqual([]);
  });
});
