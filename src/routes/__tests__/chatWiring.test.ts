/**
 * Route authorization wiring for chat and task-message routes.
 *
 * Same router-stack inspection pattern as Batches 3/5/6 — no supertest.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requireAdmin: Object.assign(jest.fn(), { mwName: 'requireAdmin' }),
  requireSuperAdmin: Object.assign(jest.fn(), { mwName: 'requireSuperAdmin' }),
  requireManagerOrAdmin: Object.assign(jest.fn(), { mwName: 'requireManagerOrAdmin' }),
}));

jest.mock('../../middleware/permissions', () => ({
  checkPermission: jest.fn((p: string) =>
    Object.assign(jest.fn(), { mwName: `checkPermission(${p})` })
  ),
}));

jest.mock('../../middleware/upload', () => ({
  __esModule: true,
  default: { single: jest.fn(() => Object.assign(jest.fn(), { mwName: 'upload.single' })) },
  uploadChatAttachment: {
    single: jest.fn(() => Object.assign(jest.fn(), { mwName: 'uploadChatAttachment.single' })),
  },
}));

jest.mock('../../config/firebase', () => ({ bucket: { name: 'test-bucket' } }));

jest.mock('../../controllers/chatController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `chat.${prop}` }),
}));

jest.mock('../../controllers/uploadController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `upload.${prop}` }),
}));

jest.mock('../../controllers/taskMessagesController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `taskMsg.${prop}` }),
}));

import chatRouter from '../chatRoutes';
import taskMessagesRouter from '../taskMessages';

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

function allRoutes(router: any): Array<{ method: string; path: string; index: number }> {
  return router.stack
    .map((l: any, index: number) => ({ l, index }))
    .filter(({ l }: any) => l.route)
    .flatMap(({ l, index }: any) =>
      Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path, index }))
    );
}

function allMiddleware(router: any): string[] {
  return router.stack.flatMap((l: any) =>
    l.route ? l.route.stack.map((s: any) => s.handle.mwName) : [l.handle?.mwName]
  );
}

describe('chat router — authentication', () => {
  it('applies authenticate at router level', () => {
    expect(routerLevelMiddleware(chatRouter)).toContain('authenticate');
  });

  it('mounts no route with optionalAuth', () => {
    for (const { method, path } of allRoutes(chatRouter)) {
      expect(handlersFor(chatRouter, method, path)).not.toContain('optionalAuth');
    }
  });

  it('guards the three super-admin chat routes with requireSuperAdmin', () => {
    expect(handlersFor(chatRouter, 'get', '/superadmin/users')).toEqual([
      'requireSuperAdmin',
      'chat.superAdminGetAllUsers',
    ]);
    expect(handlersFor(chatRouter, 'get', '/superadmin/users/:userId/groups')).toContain(
      'requireSuperAdmin'
    );
    expect(handlersFor(chatRouter, 'get', '/superadmin/groups/:groupId/messages')).toContain(
      'requireSuperAdmin'
    );
  });

  it('registers the super-admin routes before the parameterised group routes', () => {
    const routes = allRoutes(chatRouter);
    const superAdminIndex = routes.find((r) => r.path === '/superadmin/users')!.index;
    const groupIndex = routes.find((r) => r.path === '/groups/:groupId')!.index;

    expect(superAdminIndex).toBeLessThan(groupIndex);
  });
});

describe('chat router — group and message routes carry no permission middleware', () => {
  // FINDING (documented, NOT fixed): every group, message and key route relies
  // solely on router-level `authenticate` plus controller-side membership
  // checks. No checkPermission / project-permission middleware is mounted, so a
  // controller that forgets its own check is completely unguarded.
  it('mounts group CRUD routes with the controller as the only handler', () => {
    for (const [method, path] of [
      ['post', '/groups'],
      ['get', '/groups'],
      ['get', '/groups/:groupId'],
      ['put', '/groups/:groupId'],
      ['delete', '/groups/:groupId'],
      ['post', '/groups/:groupId/members'],
      ['delete', '/groups/:groupId/members/:userId'],
      ['post', '/groups/:groupId/leave'],
    ] as Array<[string, string]>) {
      expect(handlersFor(chatRouter, method, path)).toHaveLength(1);
    }
  });

  it('mounts message routes with the controller as the only handler', () => {
    for (const [method, path] of [
      ['post', '/messages'],
      ['get', '/groups/:groupId/messages'],
      ['put', '/messages/:messageId'],
      ['delete', '/messages/:messageId'],
      ['put', '/messages/:messageId/read'],
    ] as Array<[string, string]>) {
      expect(handlersFor(chatRouter, method, path)).toHaveLength(1);
    }
  });

  it('mounts the E2E key routes with the controller as the only handler', () => {
    expect(handlersFor(chatRouter, 'get', '/groups/:groupId/member-keys')).toEqual([
      'chat.getGroupMemberKeys',
    ]);
    expect(handlersFor(chatRouter, 'post', '/groups/:groupId/rotate-key')).toEqual([
      'chat.rotateGroupKey',
    ]);
    expect(handlersFor(chatRouter, 'post', '/member-public-keys')).toEqual([
      'chat.getPublicKeysForUsers',
    ]);
  });

  it('mounts no project-permission middleware anywhere on the chat router', () => {
    expect(allMiddleware(chatRouter).filter((m) => m?.startsWith('checkPermission('))).toEqual([]);
  });

  it('mounts no admin or manager role gate on the chat router', () => {
    const mounted = allMiddleware(chatRouter);
    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireManagerOrAdmin');
  });

  it('routes reaction, pin and star to their own distinct handlers', () => {
    expect(handlersFor(chatRouter, 'post', '/messages/:messageId/reaction')).toEqual([
      'chat.toggleReaction',
    ]);
    expect(handlersFor(chatRouter, 'put', '/messages/:messageId/pin')).toEqual(['chat.togglePin']);
    expect(handlersFor(chatRouter, 'put', '/messages/:messageId/star')).toEqual(['chat.toggleStar']);
  });
});

describe('chat router — attachment upload', () => {
  it('wraps the chat upload route in a multer handler before the controller', () => {
    const handlers = handlersFor(chatRouter, 'post', '/groups/:groupId/upload');

    expect(handlers).toHaveLength(2);
    expect(handlers[1]).toBe('upload.uploadChatAttachment');
  });

  // FINDING (documented, NOT fixed): the upload route carries no group
  // membership middleware — authorization depends entirely on the controller.
  it('applies no membership or permission middleware to the upload route', () => {
    const handlers = handlersFor(chatRouter, 'post', '/groups/:groupId/upload');

    expect(handlers.some((h) => h.startsWith('checkPermission('))).toBe(false);
    expect(handlers).not.toContain('requireSuperAdmin');
  });

  // FINDING (documented, NOT fixed): two debug endpoints are mounted on the
  // live chat router behind authenticate only. /debug/storage writes, publishes
  // and deletes a real object in the configured Firebase bucket and returns the
  // bucket name, and its error branch echoes the raw message to the caller.
  it('exposes debug storage and upload-test endpoints to any authenticated user', () => {
    expect(handlersFor(chatRouter, 'get', '/debug/storage')).toHaveLength(1);
    expect(handlersFor(chatRouter, 'post', '/groups/:groupId/upload-test')).toHaveLength(2);
  });
});

describe('task messages router', () => {
  it('applies authenticate at router level', () => {
    expect(routerLevelMiddleware(taskMessagesRouter)).toContain('authenticate');
  });

  it('exposes exactly three routes, each with a single controller handler', () => {
    const routes = allRoutes(taskMessagesRouter).map((r) => `${r.method} ${r.path}`).sort();

    expect(routes).toEqual(['delete /:messageId', 'get /:taskId', 'post /:taskId'].sort());
    for (const { method, path } of allRoutes(taskMessagesRouter)) {
      expect(handlersFor(taskMessagesRouter, method, path)).toHaveLength(1);
    }
  });

  it('routes read, send and delete to their own handlers', () => {
    expect(handlersFor(taskMessagesRouter, 'get', '/:taskId')).toEqual(['taskMsg.getMessages']);
    expect(handlersFor(taskMessagesRouter, 'post', '/:taskId')).toEqual(['taskMsg.sendMessage']);
    expect(handlersFor(taskMessagesRouter, 'delete', '/:messageId')).toEqual([
      'taskMsg.deleteMessage',
    ]);
  });

  // Task-message authorization is entirely controller-side (checkTaskAccess);
  // the route layer adds nothing beyond authentication.
  it('mounts no permission or role middleware', () => {
    const mounted = allMiddleware(taskMessagesRouter);

    expect(mounted.filter((m) => m?.startsWith('checkPermission('))).toEqual([]);
    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireSuperAdmin');
  });
});
