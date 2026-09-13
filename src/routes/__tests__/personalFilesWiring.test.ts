/**
 * Personal Files route wiring.
 *
 * Same router-stack inspection pattern as the other wiring tests - no supertest.
 * These lock the guards that are easy to lose in a refactor: the router-level
 * `authenticate`, the upload route's rate limiter and multer instance, and the
 * ordering that keeps literal paths from being swallowed by `/:id`.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requirePersonalFilesPermission: jest.fn((action: string) =>
    Object.assign(jest.fn(), { mwName: `requirePersonalFiles(${action})` })
  )
}));

jest.mock('../../middleware/rateLimiter', () => ({
  uploadLimiter: Object.assign(jest.fn(), { mwName: 'uploadLimiter' })
}));

jest.mock('../../middleware/upload', () => ({
  uploadPersonalFile: {
    single: jest.fn((field: string) => Object.assign(jest.fn(), { mwName: `multer.single(${field})` }))
  }
}));

const controllerProxy = (prefix: string) =>
  new Proxy(
    {},
    { get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `${prefix}.${prop}` }) }
  );

jest.mock('../../controllers/personalFilesController', () => controllerProxy('pf'));

import personalFilesRouter from '../personalFiles';
import { uploadPersonalFile } from '../../middleware/upload';

function handlersFor(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s: any) => s.handle.mwName ?? s.handle.name ?? 'anonymous');
}

function routerLevelMiddleware(router: any): string[] {
  return router.stack.filter((l: any) => !l.route).map((l: any) => l.handle?.mwName ?? 'anonymous');
}

function allRoutes(router: any): Array<{ method: string; path: string }> {
  return router.stack
    .filter((l: any) => l.route)
    .flatMap((l: any) => Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path })));
}

describe('personal-files router - authentication', () => {
  it('applies authenticate at the router level, so every route is protected', () => {
    expect(routerLevelMiddleware(personalFilesRouter)).toContain('authenticate');
  });

  it('exposes no route that bypasses the router-level guard', () => {
    // authenticate is mounted with router.use(), so no individual route needs its
    // own copy - but there must be no route registered BEFORE that middleware.
    const authIndex = personalFilesRouter.stack.findIndex(
      (l: any) => !l.route && l.handle?.mwName === 'authenticate'
    );
    const firstRouteIndex = personalFilesRouter.stack.findIndex((l: any) => !!l.route);
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(firstRouteIndex);
  });
});

describe('personal-files router - upload hardening', () => {
  it('reuses the existing uploadLimiter on the upload route', () => {
    expect(handlersFor(personalFilesRouter, 'post', '/upload')).toContain('uploadLimiter');
  });

  it('uses the dedicated personal-files multer instance for a single "file" field', () => {
    // The router calls uploadPersonalFile.single('file') at module load, and the
    // suite runs with clearMocks, so the call record is already gone by now. The
    // mounted handler's name carries the field through instead.
    expect(typeof uploadPersonalFile.single).toBe('function');
    expect(handlersFor(personalFilesRouter, 'post', '/upload')).toContain('multer.single(file)');
  });

  it('orders the upload route as limiter, permission, multer, error handler, controller', () => {
    const handlers = handlersFor(personalFilesRouter, 'post', '/upload');
    // Rate limit first (cheapest rejection), then the permission gate, and only
    // then multer - so neither a throttled nor a forbidden request ever writes
    // bytes to disk. A multer error handler sits between the parser and the
    // controller so a rejected upload answers with a JSON envelope.
    expect(handlers).toEqual([
      'uploadLimiter',
      'requirePersonalFiles(create)',
      'multer.single(file)',
      'handlePersonalFileUploadError',
      'pf.uploadFile'
    ]);
  });

  it('applies the rate limiter ONLY to the upload route, leaving reads unthrottled', () => {
    const limited = allRoutes(personalFilesRouter).filter(({ method, path }) =>
      handlersFor(personalFilesRouter, method, path).includes('uploadLimiter')
    );
    expect(limited).toEqual([{ method: 'post', path: '/upload' }]);
  });
});

describe('personal-files router - route table', () => {
  it('registers every documented endpoint', () => {
    const routes = allRoutes(personalFilesRouter).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /',
        'GET /tree',
        'GET /search',
        'GET /usage',
        'GET /recycle-bin',
        'GET /:id/breadcrumb',
        'GET /:id/download',
        'POST /folders',
        'POST /upload',
        'POST /bulk',
        'POST /:id/copy',
        'POST /:id/restore',
        'PATCH /:id/rename',
        'PATCH /:id/move',
        'DELETE /:id',
        'DELETE /:id/permanent'
      ])
    );
  });

  it('wires each route to its own controller handler', () => {
    expect(handlersFor(personalFilesRouter, 'get', '/')).toContain('pf.listItems');
    expect(handlersFor(personalFilesRouter, 'get', '/tree')).toContain('pf.getTree');
    expect(handlersFor(personalFilesRouter, 'get', '/search')).toContain('pf.searchItems');
    expect(handlersFor(personalFilesRouter, 'get', '/usage')).toContain('pf.getUsage');
    expect(handlersFor(personalFilesRouter, 'get', '/recycle-bin')).toContain('pf.listRecycleBin');
    expect(handlersFor(personalFilesRouter, 'get', '/:id/download')).toContain('pf.downloadFile');
    expect(handlersFor(personalFilesRouter, 'get', '/:id/breadcrumb')).toContain('pf.getBreadcrumb');
    expect(handlersFor(personalFilesRouter, 'post', '/folders')).toContain('pf.createFolder');
    expect(handlersFor(personalFilesRouter, 'post', '/bulk')).toContain('pf.bulkOperation');
    expect(handlersFor(personalFilesRouter, 'post', '/:id/copy')).toContain('pf.copyItem');
    expect(handlersFor(personalFilesRouter, 'post', '/:id/restore')).toContain('pf.restoreItem');
    expect(handlersFor(personalFilesRouter, 'patch', '/:id/rename')).toContain('pf.renameItem');
    expect(handlersFor(personalFilesRouter, 'patch', '/:id/move')).toContain('pf.moveItem');
    expect(handlersFor(personalFilesRouter, 'delete', '/:id')).toContain('pf.deleteItem');
    expect(handlersFor(personalFilesRouter, 'delete', '/:id/permanent')).toContain(
      'pf.permanentDeleteItem'
    );
  });

  it('declares literal GET paths before the parameterised ones', () => {
    // Express matches in registration order. If GET /:id/... were registered
    // first, "tree"/"search"/"usage" would be captured as ids.
    const paths = personalFilesRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    const firstParam = paths.findIndex((p: string) => p.includes(':id'));
    for (const literal of ['/tree', '/search', '/usage', '/recycle-bin', '/folders', '/upload', '/bulk']) {
      expect(paths.indexOf(literal)).toBeLessThan(firstParam);
    }
  });

  it('declares DELETE /:id/permanent before DELETE /:id', () => {
    const deleteLayers = personalFilesRouter.stack
      .filter((l: any) => l.route?.methods?.delete)
      .map((l: any) => l.route.path);
    expect(deleteLayers.indexOf('/:id/permanent')).toBeLessThan(deleteLayers.indexOf('/:id'));
  });

  it('exposes no route that could serve a file without going through the controller', () => {
    // Personal file bytes must leave the server only via GET /:id/download.
    const downloadRoutes = allRoutes(personalFilesRouter).filter((r) => r.path.includes('download'));
    expect(downloadRoutes).toEqual([{ method: 'get', path: '/:id/download' }]);
  });
});

describe('personal-files router - module permission gates', () => {
  /** Every route, with the permission gate it carries (or none). */
  const EXPECTED_GATES: Array<[string, string, string | null]> = [
    // Reading anything about your own drive needs view.
    ['get', '/', 'view'],
    ['get', '/tree', 'view'],
    ['get', '/search', 'view'],
    ['get', '/usage', 'view'],
    ['get', '/recycle-bin', 'view'],
    ['get', '/:id/breadcrumb', 'view'],
    ['get', '/:id/download', 'view'],
    // Anything that writes new documents or new bytes needs create.
    ['post', '/folders', 'create'],
    ['post', '/upload', 'create'],
    ['post', '/:id/copy', 'create'],
    // Changing an existing item in place needs edit.
    ['patch', '/:id/rename', 'edit'],
    ['patch', '/:id/move', 'edit'],
    // Removing, and undoing a removal, share the delete capability.
    ['delete', '/:id', 'delete'],
    ['delete', '/:id/permanent', 'delete'],
    ['post', '/:id/restore', 'delete'],
    // /bulk carries its operation in the body, so the controller gates it.
    ['post', '/bulk', null]
  ];

  it.each(EXPECTED_GATES)('%s %s is gated on %s', (method, path, action) => {
    const handlers = handlersFor(personalFilesRouter, method, path);
    const gates = handlers.filter((h) => h.startsWith('requirePersonalFiles('));
    if (action === null) {
      expect(gates).toEqual([]);
    } else {
      expect(gates).toEqual([`requirePersonalFiles(${action})`]);
    }
  });

  it('leaves no route ungated except /bulk', () => {
    const ungated = allRoutes(personalFilesRouter).filter(
      ({ method, path }) =>
        !handlersFor(personalFilesRouter, method, path).some((h) =>
          h.startsWith('requirePersonalFiles(')
        )
    );
    expect(ungated).toEqual([{ method: 'post', path: '/bulk' }]);
  });

  it('checks the upload permission BEFORE multer writes any bytes', () => {
    const handlers = handlersFor(personalFilesRouter, 'post', '/upload');
    const gateAt = handlers.indexOf('requirePersonalFiles(create)');
    const multerAt = handlers.indexOf('multer.single(file)');
    expect(gateAt).toBeGreaterThan(-1);
    expect(multerAt).toBeGreaterThan(-1);
    // Otherwise a forbidden upload would land on disk and need cleaning up.
    expect(gateAt).toBeLessThan(multerAt);
  });

  it('keeps every gate behind authenticate', () => {
    // A permission gate reads req.user, so authentication has to have run first.
    const authIndex = personalFilesRouter.stack.findIndex(
      (l: any) => !l.route && l.handle?.mwName === 'authenticate'
    );
    const firstRouteIndex = personalFilesRouter.stack.findIndex((l: any) => !!l.route);
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(firstRouteIndex);
  });

  it('does not gate on a role - Personal Files is permission-gated only', () => {
    // requireAdmin/requireManagerOrAdmin here would imply privileged users can
    // reach other people's drives, which must never be true.
    const everyHandler = allRoutes(personalFilesRouter).flatMap(({ method, path }) =>
      handlersFor(personalFilesRouter, method, path)
    );
    for (const handler of everyHandler) {
      expect(handler).not.toMatch(/requireAdmin|requireManagerOrAdmin|requireSuperAdmin/);
    }
  });
});
