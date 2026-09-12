/**
 * Authentication route wiring: which middleware is actually mounted on each
 * auth endpoint. Uses the same router-stack inspection pattern as
 * src/routes/__tests__/authorizationWiring.test.ts (Batch 3) — no supertest.
 *
 * These are regression locks: if a future change drops `authenticate` from a
 * sensitive route, or widens a public one, a test here fails.
 */

jest.mock('../../middleware/auth', () => ({
  authenticate: Object.assign(jest.fn(), { mwName: 'authenticate' }),
  optionalAuth: Object.assign(jest.fn(), { mwName: 'optionalAuth' }),
  requireManagerOrAdmin: Object.assign(jest.fn(), { mwName: 'requireManagerOrAdmin' }),
  requireAdmin: Object.assign(jest.fn(), { mwName: 'requireAdmin' }),
  requireSuperAdmin: Object.assign(jest.fn(), { mwName: 'requireSuperAdmin' }),
  requireActiveUser: Object.assign(jest.fn(), { mwName: 'requireActiveUser' }),
  requireEmailVerified: Object.assign(jest.fn(), { mwName: 'requireEmailVerified' }),
}));

jest.mock('../../controllers/authController', () => new Proxy({}, {
  get: (_t, prop: string) => Object.assign(jest.fn(), { mwName: `auth.${prop}` }),
}));

jest.mock('../../middleware/upload', () => ({
  uploadAvatar: { single: jest.fn(() => Object.assign(jest.fn(), { mwName: 'uploadAvatar.single' })) },
}));

jest.mock('../../lib/dynamicRouteStore', () => ({
  dynamicRouteStore: { clearUserRoutes: jest.fn() },
}));

jest.mock('../../models', () => ({
  User: { findByIdAndUpdate: jest.fn() },
  AuditLog: { logSystemEvent: jest.fn() },
}));

import authRouter from '../auth';

/** Handler names mounted on a given method + path. */
function handlersFor(router: any, method: string, path: string): string[] {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  );
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((s: any) => s.handle.mwName ?? s.handle.name ?? 'anonymous');
}

/** Index of a route within the router stack (routes after router.use are protected). */
function indexOfRoute(router: any, method: string, path: string): number {
  return router.stack.findIndex(
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  );
}

/** Index of the router-level `authenticate` middleware. */
function authenticateUseIndex(router: any): number {
  return router.stack.findIndex((l: any) => !l.route && l.handle?.mwName === 'authenticate');
}

function allRoutes(router: any): Array<{ method: string; path: string; index: number }> {
  return router.stack
    .map((l: any, index: number) => ({ l, index }))
    .filter(({ l }: any) => l.route)
    .flatMap(({ l, index }: any) =>
      Object.keys(l.route.methods).map((method) => ({ method, path: l.route.path, index }))
    );
}

describe('auth router — public endpoints', () => {
  it('mounts login, forgot-password and reset-password before any authentication', () => {
    const gate = authenticateUseIndex(authRouter);

    for (const [method, path] of [
      ['post', '/login'],
      ['post', '/forgot-password'],
      ['post', '/reset-password'],
    ] as Array<[string, string]>) {
      expect(indexOfRoute(authRouter, method, path)).toBeLessThan(gate);
      expect(handlersFor(authRouter, method, path)).not.toContain('authenticate');
    }
  });

  it('exposes exactly three fully public endpoints plus logout', () => {
    const gate = authenticateUseIndex(authRouter);
    const preGate = allRoutes(authRouter)
      .filter((r) => r.index < gate)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(preGate).toEqual(
      ['post /forgot-password', 'post /login', 'post /logout', 'post /reset-password'].sort()
    );
  });

  it('wires login and the password-reset pair straight to their controllers', () => {
    expect(handlersFor(authRouter, 'post', '/login')).toEqual(['auth.login']);
    expect(handlersFor(authRouter, 'post', '/forgot-password')).toEqual(['auth.requestPasswordReset']);
    expect(handlersFor(authRouter, 'post', '/reset-password')).toEqual(['auth.resetPassword']);
  });

  it('protects logout with optionalAuth rather than authenticate', () => {
    // Deliberate: logout must succeed for an already-invalid token. Batch 1
    // documented that optionalAuth performs no session (jti) validation.
    const handlers = handlersFor(authRouter, 'post', '/logout');
    expect(handlers).toContain('optionalAuth');
    expect(handlers).not.toContain('authenticate');
  });
});

describe('auth router — protected endpoints', () => {
  it('applies authenticate at router level to every remaining route', () => {
    expect(authenticateUseIndex(authRouter)).toBeGreaterThan(-1);
  });

  it.each([
    ['get', '/me'],
    ['get', '/profile'],
    ['put', '/profile'],
    ['post', '/deactivate'],
    ['put', '/password'],
    ['delete', '/account'],
    ['get', '/settings'],
    ['put', '/settings'],
    ['get', '/dashboard'],
  ])('mounts %s %s behind the router-level authenticate gate', (method, path) => {
    expect(indexOfRoute(authRouter, method, path)).toBeGreaterThan(authenticateUseIndex(authRouter));
  });

  it('mounts every passkey route behind authentication', () => {
    const gate = authenticateUseIndex(authRouter);

    for (const [method, path] of [
      ['get', '/passkey/status'],
      ['post', '/passkey/set'],
      ['post', '/passkey/verify'],
      ['put', '/passkey/change'],
    ] as Array<[string, string]>) {
      expect(indexOfRoute(authRouter, method, path)).toBeGreaterThan(gate);
      expect(handlersFor(authRouter, method, path)).toHaveLength(1);
    }
  });

  it('routes the sensitive account operations to their own distinct controllers', () => {
    expect(handlersFor(authRouter, 'put', '/password')).toEqual(['auth.updatePassword']);
    expect(handlersFor(authRouter, 'delete', '/account')).toEqual(['auth.deleteAccount']);
    expect(handlersFor(authRouter, 'post', '/deactivate')).toEqual(['auth.deactivateAccount']);
    expect(handlersFor(authRouter, 'get', '/me')).toEqual(['auth.getCurrentUser']);
  });

  it('guards the role-change route with requireManagerOrAdmin', () => {
    expect(handlersFor(authRouter, 'put', '/users/:userId/role')).toEqual([
      'requireManagerOrAdmin',
      'auth.updateUserRole',
    ]);
  });

  it('leaves the user-listing routes on authentication alone, with no role gate', () => {
    // Documents that /users, /users/search and /users/with-passwords rely on
    // controller-side permission checks rather than route middleware.
    for (const path of ['/users', '/users/search', '/users/with-passwords']) {
      const handlers = handlersFor(authRouter, 'get', path);
      expect(handlers).toHaveLength(1);
      expect(handlers).not.toContain('requireManagerOrAdmin');
      expect(handlers).not.toContain('requireAdmin');
    }
  });

  it('applies authenticate a second time on the avatar upload route', () => {
    expect(handlersFor(authRouter, 'post', '/avatar')).toEqual([
      'authenticate',
      'uploadAvatar.single',
      'auth.uploadAvatar',
    ]);
  });

  it('places every chat-lock and per-chat-lock route behind authentication', () => {
    const gate = authenticateUseIndex(authRouter);

    for (const [method, path] of [
      ['get', '/chat-lock'],
      ['put', '/chat-lock'],
      ['post', '/chat-lock/verify'],
      ['get', '/per-chat-lock-credential'],
      ['put', '/per-chat-lock-credential'],
    ] as Array<[string, string]>) {
      expect(indexOfRoute(authRouter, method, path)).toBeGreaterThan(gate);
    }
  });
});

describe('auth router — middleware that is never mounted', () => {
  // FINDING (corroborates Batch 1, documented not fixed): authenticate builds
  // req.user from a six-field whitelist that omits isActive and emailVerified,
  // while requireActiveUser and requireEmailVerified read exactly those fields
  // — so both would deny every request. They are exported but mounted on no
  // route, which is why the defect is latent rather than breaking the app.
  it('mounts neither requireActiveUser nor requireEmailVerified anywhere on the auth router', () => {
    const mounted = authRouter.stack.flatMap((l: any) =>
      l.route
        ? l.route.stack.map((s: any) => s.handle.mwName)
        : [l.handle?.mwName]
    );

    expect(mounted).not.toContain('requireActiveUser');
    expect(mounted).not.toContain('requireEmailVerified');
  });

  it('mounts no admin or superadmin gate on the auth router', () => {
    const mounted = authRouter.stack.flatMap((l: any) =>
      l.route ? l.route.stack.map((s: any) => s.handle.mwName) : [l.handle?.mwName]
    );

    expect(mounted).not.toContain('requireAdmin');
    expect(mounted).not.toContain('requireSuperAdmin');
    // requireManagerOrAdmin is the only role gate present.
    expect(mounted).toContain('requireManagerOrAdmin');
  });

  it('exports requireActiveUser and requireEmailVerified despite their being unused', () => {
    const middleware = jest.requireActual('../../middleware/auth');
    expect(typeof middleware.requireActiveUser).toBe('function');
    expect(typeof middleware.requireEmailVerified).toBe('function');
  });
});

describe('webauthn controller — routing gap', () => {
  // FINDING (new, documented not fixed): webauthnController exports five
  // handlers (register options/verify, auth options/verify, status) but no
  // router imports it, so the biometric endpoints are unreachable. The
  // jti-less-token behaviour covered in webauthnController.test.ts is therefore
  // latent rather than live.
  it('is imported by no router in src/routes', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const routesDir = path.join(__dirname, '..');

    const referencing = fs
      .readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => fs.readFileSync(path.join(routesDir, f), 'utf8').includes('webauthn'));

    expect(referencing).toEqual([]);
  });

  it('still exports the handlers it defines, so wiring it up would expose them', () => {
    const controller = jest.requireActual('../../controllers/webauthnController');

    for (const handler of [
      'getRegisterOptions',
      'verifyRegistration',
      'getAuthOptions',
      'verifyAuthentication',
      'getBiometricStatus',
    ]) {
      expect(typeof controller[handler]).toBe('function');
    }
  });
});
