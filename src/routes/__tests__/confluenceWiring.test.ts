/**
 * Confluence route wiring — same router-stack inspection pattern as
 * sharedFilesWiring.test.ts. Locks the guards that are easy to lose in a
 * refactor: router-level authenticate + view gate ahead of every route, the
 * create/comment gates, the image route's ordering (permission BEFORE multer),
 * and literal paths registered before /:id.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  requireConfluencePermission: jest.fn((action: string) =>
    Object.assign(jest.fn(), { mwName: `requireConfluence(${action})` })
  )
}));

jest.mock('../../middleware/rateLimiter', () => ({
  uploadLimiter: Object.assign(jest.fn(), { mwName: 'uploadLimiter' })
}));

jest.mock('../../middleware/upload', () => ({
  uploadConfluenceImage: {
    single: jest.fn((field: string) => Object.assign(jest.fn(), { mwName: `multer.single(${field})` }))
  }
}));

jest.mock('../../controllers/confluenceController', () =>
  new Proxy(
    {},
    { get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `cf.${prop}` }) }
  )
);

import confluenceRouter from '../confluence';

function handlersFor(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s: any) => s.handle.mwName ?? s.handle.name ?? 'anonymous');
}

function routeIndex(router: any, method: string, path: string): number {
  return router.stack.findIndex((l: any) => l.route?.path === path && l.route?.methods?.[method]);
}

describe('confluence router — router-level guards', () => {
  const routerLevel = confluenceRouter.stack.filter((l: any) => !l.route).map((l: any) => l.handle?.mwName);

  it('applies authenticate and the view gate at the router level, in that order', () => {
    expect(routerLevel.slice(0, 2)).toEqual(['authenticate', 'requireConfluence(view)']);
  });

  it('registers no route before those guards', () => {
    const lastGuard = confluenceRouter.stack.findIndex((l: any) => l.handle?.mwName === 'requireConfluence(view)');
    const firstRoute = confluenceRouter.stack.findIndex((l: any) => !!l.route);
    expect(lastGuard).toBeLessThan(firstRoute);
  });
});

describe('confluence router — per-action gates', () => {
  it('requires create to create a page', () => {
    expect(handlersFor(confluenceRouter, 'post', '/pages')).toEqual(['requireConfluence(create)', 'cf.createPage']);
  });

  it('requires comment to add a comment', () => {
    expect(handlersFor(confluenceRouter, 'post', '/pages/:id/comments')).toEqual(['requireConfluence(comment)', 'cf.addComment']);
  });

  it('orders the image route as limiter, author check, multer, error handler, controller', () => {
    const handlers = handlersFor(confluenceRouter, 'post', '/images');
    expect(handlers[0]).toBe('uploadLimiter');
    expect(handlers[1]).toBe('cf.requireConfluenceAuthor');
    expect(handlers[2]).toBe('multer.single(image)');
    expect(handlers[handlers.length - 1]).toBe('cf.uploadImage');
  });
});

describe('confluence router — version history', () => {
  // No route-level gate beyond the router's authenticate + view: page access and
  // restore rights are decided per page in the controller (404 for invisible pages).
  it.each([
    ['get', '/pages/:id/versions', 'cf.listVersions'],
    ['get', '/pages/:id/versions/:version', 'cf.getVersion'],
    ['post', '/pages/:id/versions/:version/restore', 'cf.restoreVersion']
  ])('wires %s %s to %s', (method, path, handler) => {
    expect(handlersFor(confluenceRouter, method, path)).toEqual([handler]);
  });

  it('has no route that reads a version by its own id', () => {
    const paths = confluenceRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path as string);
    expect(paths.filter((p: string) => p.includes('version') && !p.startsWith('/pages/:id/'))).toEqual([]);
  });
});

describe('confluence router — collaboration', () => {
  it.each([
    ['get', '/mentionable-users', 'cf.searchMentionableUsers'],
    ['get', '/pages/:id/activity', 'cf.listActivity']
  ])('wires %s %s to %s (behind the router-level auth + view gate)', (method, path, handler) => {
    expect(handlersFor(confluenceRouter, method, path)).toEqual([handler]);
  });
});

describe('confluence router — review workflow', () => {
  // Rights are checked per page in each handler (edit to submit/withdraw, edit +
  // publish to approve/request changes), behind the router-level auth + view gate.
  it.each([
    ['/pages/:id/review/submit', 'cf.submitForReview'],
    ['/pages/:id/review/withdraw', 'cf.withdrawReview'],
    ['/pages/:id/review/approve', 'cf.approveReview'],
    ['/pages/:id/review/request-changes', 'cf.requestChanges']
  ])('wires POST %s to %s', (path, handler) => {
    expect(handlersFor(confluenceRouter, 'post', path)).toEqual([handler]);
  });

  it('exposes no GET route that changes review state', () => {
    const reviewGets = confluenceRouter.stack
      .filter((l: any) => l.route?.methods?.get && String(l.route.path).includes('/review'));
    expect(reviewGets).toEqual([]);
  });
});

describe('confluence router — literal paths before /:id', () => {
  it.each(['/pages/tree', '/pages/search'])('registers GET %s before GET /pages/:id', (path) => {
    expect(routeIndex(confluenceRouter, 'get', path)).toBeLessThan(routeIndex(confluenceRouter, 'get', '/pages/:id'));
  });
});
