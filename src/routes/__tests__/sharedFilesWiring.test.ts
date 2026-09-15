/**
 * Shared Files route wiring.
 *
 * Same router-stack inspection pattern as personalFilesWiring.test.ts - no
 * supertest. These lock the guards that are easy to lose in a refactor: the
 * router-level `authenticate`, the per-action module permission gate on every
 * route, the upload route's ordering (permission BEFORE multer), and the ordering
 * that keeps literal paths from being swallowed by `/:id`.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requireSharedFilesPermission: jest.fn((action: string) =>
    Object.assign(jest.fn(), { mwName: `requireSharedFiles(${action})` })
  ),
  requirePersonalFilesPermission: jest.fn((action: string) =>
    Object.assign(jest.fn(), { mwName: `requirePersonalFiles(${action})` })
  )
}));

jest.mock('../../middleware/rateLimiter', () => ({
  uploadLimiter: Object.assign(jest.fn(), { mwName: 'uploadLimiter' })
}));

jest.mock('../../middleware/upload', () => ({
  uploadSharedFile: {
    single: jest.fn((field: string) => Object.assign(jest.fn(), { mwName: `multer.single(${field})` }))
  },
  uploadPersonalFile: {
    single: jest.fn((field: string) => Object.assign(jest.fn(), { mwName: `PERSONAL.multer.single(${field})` }))
  }
}));

const controllerProxy = (prefix: string) =>
  new Proxy(
    {},
    { get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `${prefix}.${prop}` }) }
  );

jest.mock('../../controllers/sharedFilesController', () => controllerProxy('sf'));

import sharedFilesRouter from '../sharedFiles';
import { uploadSharedFile } from '../../middleware/upload';

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

describe('shared-files router - authentication', () => {
  it('applies authenticate at the router level, so every route is protected', () => {
    expect(routerLevelMiddleware(sharedFilesRouter)).toContain('authenticate');
  });

  it('registers no route before the router-level guard', () => {
    const authIndex = sharedFilesRouter.stack.findIndex(
      (l: any) => !l.route && l.handle?.mwName === 'authenticate'
    );
    const firstRouteIndex = sharedFilesRouter.stack.findIndex((l: any) => !!l.route);
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(firstRouteIndex);
  });
});

describe('shared-files router - upload hardening', () => {
  it('reuses the existing uploadLimiter on the upload route', () => {
    expect(handlersFor(sharedFilesRouter, 'post', '/upload')).toContain('uploadLimiter');
  });

  it('uses the DEDICATED shared-files multer instance, not the personal-files one', () => {
    expect(typeof uploadSharedFile.single).toBe('function');
    const handlers = handlersFor(sharedFilesRouter, 'post', '/upload');
    expect(handlers).toContain('multer.single(file)');
    expect(handlers.join(' ')).not.toContain('PERSONAL.');
  });

  it('orders the upload route as limiter, permission, multer, error handler, controller', () => {
    expect(handlersFor(sharedFilesRouter, 'post', '/upload')).toEqual([
      'uploadLimiter',
      'requireSharedFiles(create)',
      'multer.single(file)',
      'handleSharedFileUploadError',
      'sf.uploadFile'
    ]);
  });

  it('applies the rate limiter ONLY to the upload route', () => {
    const limited = allRoutes(sharedFilesRouter).filter(({ method, path }) =>
      handlersFor(sharedFilesRouter, method, path).includes('uploadLimiter')
    );
    expect(limited).toEqual([{ method: 'post', path: '/upload' }]);
  });
});

describe('shared-files router - route table', () => {
  it('registers every documented endpoint', () => {
    const routes = allRoutes(sharedFilesRouter).map((r) => `${r.method.toUpperCase()} ${r.path}`);
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
    expect(handlersFor(sharedFilesRouter, 'get', '/')).toContain('sf.listItems');
    expect(handlersFor(sharedFilesRouter, 'get', '/tree')).toContain('sf.getTree');
    expect(handlersFor(sharedFilesRouter, 'get', '/search')).toContain('sf.searchItems');
    expect(handlersFor(sharedFilesRouter, 'get', '/usage')).toContain('sf.getUsage');
    expect(handlersFor(sharedFilesRouter, 'get', '/recycle-bin')).toContain('sf.listRecycleBin');
    expect(handlersFor(sharedFilesRouter, 'get', '/:id/download')).toContain('sf.downloadFile');
    expect(handlersFor(sharedFilesRouter, 'get', '/:id/breadcrumb')).toContain('sf.getBreadcrumb');
    expect(handlersFor(sharedFilesRouter, 'post', '/folders')).toContain('sf.createFolder');
    expect(handlersFor(sharedFilesRouter, 'post', '/bulk')).toContain('sf.bulkOperation');
    expect(handlersFor(sharedFilesRouter, 'post', '/:id/copy')).toContain('sf.copyItem');
    expect(handlersFor(sharedFilesRouter, 'post', '/:id/restore')).toContain('sf.restoreItem');
    expect(handlersFor(sharedFilesRouter, 'patch', '/:id/rename')).toContain('sf.renameItem');
    expect(handlersFor(sharedFilesRouter, 'patch', '/:id/move')).toContain('sf.moveItem');
    expect(handlersFor(sharedFilesRouter, 'delete', '/:id')).toContain('sf.deleteItem');
    expect(handlersFor(sharedFilesRouter, 'delete', '/:id/permanent')).toContain('sf.permanentDeleteItem');
  });

  it('declares literal GET paths before the parameterised ones', () => {
    const paths = sharedFilesRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    const firstParam = paths.findIndex((p: string) => p.includes(':id'));
    for (const literal of ['/tree', '/search', '/usage', '/recycle-bin', '/folders', '/upload', '/bulk']) {
      expect(paths.indexOf(literal)).toBeLessThan(firstParam);
    }
  });

  it('declares DELETE /:id/permanent before DELETE /:id', () => {
    const deleteLayers = sharedFilesRouter.stack
      .filter((l: any) => l.route?.methods?.delete)
      .map((l: any) => l.route.path);
    expect(deleteLayers.indexOf('/:id/permanent')).toBeLessThan(deleteLayers.indexOf('/:id'));
  });

  it('exposes no route that could serve a file without going through the controller', () => {
    const downloadRoutes = allRoutes(sharedFilesRouter).filter((r) => r.path.includes('download'));
    expect(downloadRoutes).toEqual([{ method: 'get', path: '/:id/download' }]);
  });
});

describe('shared-files router - module permission gates', () => {
  const EXPECTED_GATES: Array<[string, string, string | null]> = [
    ['get', '/', 'view'],
    ['get', '/tree', 'view'],
    ['get', '/search', 'view'],
    ['get', '/usage', 'view'],
    ['get', '/recycle-bin', 'view'],
    ['get', '/:id/breadcrumb', 'view'],
    ['get', '/:id/download', 'view'],
    ['post', '/folders', 'create'],
    ['post', '/upload', 'create'],
    ['post', '/:id/copy', 'create'],
    ['patch', '/:id/rename', 'edit'],
    ['patch', '/:id/move', 'edit'],
    ['delete', '/:id', 'delete'],
    ['delete', '/:id/permanent', 'delete'],
    ['post', '/:id/restore', 'delete'],
    ['post', '/bulk', null]
  ];

  it.each(EXPECTED_GATES)('%s %s is gated on %s', (method, path, action) => {
    const handlers = handlersFor(sharedFilesRouter, method, path);
    const gates = handlers.filter((h) => h.startsWith('requireSharedFiles('));
    if (action === null) {
      expect(gates).toEqual([]);
    } else {
      expect(gates).toEqual([`requireSharedFiles(${action})`]);
    }
  });

  it('leaves no route ungated except /bulk', () => {
    const ungated = allRoutes(sharedFilesRouter).filter(
      ({ method, path }) =>
        !handlersFor(sharedFilesRouter, method, path).some((h) => h.startsWith('requireSharedFiles('))
    );
    expect(ungated).toEqual([{ method: 'post', path: '/bulk' }]);
  });

  it('never uses the PERSONAL files gate anywhere', () => {
    // The two modules have different semantics; wiring the wrong gate would either
    // grant Shared Files to everyone (personalFiles defaults open) or vice versa.
    const everyHandler = allRoutes(sharedFilesRouter).flatMap(({ method, path }) =>
      handlersFor(sharedFilesRouter, method, path)
    );
    for (const handler of everyHandler) {
      expect(handler).not.toMatch(/requirePersonalFiles/);
    }
  });

  it('checks the upload permission BEFORE multer writes any bytes', () => {
    const handlers = handlersFor(sharedFilesRouter, 'post', '/upload');
    const gateAt = handlers.indexOf('requireSharedFiles(create)');
    const multerAt = handlers.indexOf('multer.single(file)');
    expect(gateAt).toBeGreaterThan(-1);
    expect(multerAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(multerAt);
  });

  it('does not gate on a role - Shared Files is permission-gated only', () => {
    const everyHandler = allRoutes(sharedFilesRouter).flatMap(({ method, path }) =>
      handlersFor(sharedFilesRouter, method, path)
    );
    for (const handler of everyHandler) {
      expect(handler).not.toMatch(/requireAdmin|requireManagerOrAdmin|requireSuperAdmin/);
    }
  });
});

describe('shared-files router - mounted in the API index', () => {
  it('is mounted at /shared-files alongside, not instead of, /personal-files', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    expect(src).toMatch(/router\.use\('\/shared-files',\s*sharedFilesRoutes\)/);
    expect(src).toMatch(/router\.use\('\/personal-files',\s*personalFilesRoutes\)/);
  });
});
