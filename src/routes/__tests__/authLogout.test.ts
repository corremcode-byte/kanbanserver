import jwt from 'jsonwebtoken';

// The logout handler is the only part of the auth router under test here.
// Every other import the router pulls in is stubbed so that importing it does
// not start Redis (dynamicRouteStore opens a connection and a sweep interval),
// nodemailer, or multer disk storage.
jest.mock('../../controllers/authController', () => new Proxy({}, {
  get: () => jest.fn(),
}));

jest.mock('../../lib/dynamicRouteStore', () => ({
  dynamicRouteStore: { clearUserRoutes: jest.fn() },
}));

jest.mock('../../middleware/auth', () => ({
  authenticate: jest.fn(),
  optionalAuth: jest.fn(),
  requireManagerOrAdmin: jest.fn(),
}));

jest.mock('../../middleware/upload', () => ({
  uploadAvatar: { single: jest.fn(() => jest.fn()) },
}));

jest.mock('../../models', () => ({
  User: { findByIdAndUpdate: jest.fn() },
  AuditLog: { logSystemEvent: jest.fn() },
}));

import { User, AuditLog } from '../../models';
import { dynamicRouteStore } from '../../lib/dynamicRouteStore';
import authRouter from '../auth';

const TEST_SECRET = 'test-jwt-secret-for-logout-suite';
const USER_ID = '507f1f77bcf86cd799439011';

let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

/**
 * Pulls the POST /logout handler straight off the router stack, so the real
 * route code runs without needing an HTTP server or supertest.
 */
function getLogoutHandler() {
  const layer = (authRouter as any).stack.find(
    (l: any) => l.route?.path === '/logout' && l.route?.methods?.post
  );
  if (!layer) throw new Error('POST /logout route not found on the auth router');
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.clearCookie = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return { headers: {}, cookies: {}, ...overrides };
}

const authedUser = { _id: USER_ID, displayName: 'Test User', email: 'user@example.com' };

beforeEach(() => {
  (User.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  (dynamicRouteStore.clearUserRoutes as jest.Mock).mockResolvedValue(undefined);
});

describe('POST /auth/logout', () => {
  it('pulls the token jti out of activeSessions, revoking that session', async () => {
    const token = jwt.sign({ userId: USER_ID, jti: 'session-to-kill' }, TEST_SECRET);
    const res = makeRes();

    await getLogoutHandler()(
      makeReq({ user: authedUser, headers: { authorization: `Bearer ${token}` } }),
      res
    );

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
      $pull: { activeSessions: { jti: 'session-to-kill' } },
    });
  });

  it('reads the token from the auth_token cookie when there is no Bearer header', async () => {
    const token = jwt.sign({ userId: USER_ID, jti: 'cookie-session' }, TEST_SECRET);

    await getLogoutHandler()(makeReq({ user: authedUser, cookies: { auth_token: token } }), makeRes());

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
      $pull: { activeSessions: { jti: 'cookie-session' } },
    });
  });

  it('clears the user route tokens, stamps lastLogoutAt, writes an audit entry and clears the cookie', async () => {
    const token = jwt.sign({ userId: USER_ID, jti: 'session-1' }, TEST_SECRET);
    const res = makeRes();

    await getLogoutHandler()(
      makeReq({ user: authedUser, headers: { authorization: `Bearer ${token}` } }),
      res
    );

    expect(dynamicRouteStore.clearUserRoutes).toHaveBeenCalledWith(USER_ID);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ lastLogoutAt: expect.any(Date) })
    );
    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, action: 'user_logout' })
    );
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token', expect.objectContaining({
      httpOnly: true,
      path: '/',
    }));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'Logged out successfully' })
    );
  });

  it('succeeds without touching the database for an unauthenticated request', async () => {
    const res = makeRes();

    await getLogoutHandler()(makeReq(), res);

    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(AuditLog.logSystemEvent).not.toHaveBeenCalled();
    expect(dynamicRouteStore.clearUserRoutes).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token', expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still records the logout when the token is unverifiable, but removes no jti', async () => {
    const res = makeRes();

    await getLogoutHandler()(
      makeReq({ user: authedUser, headers: { authorization: 'Bearer not-a-real-token' } }),
      res
    );

    expect(User.findByIdAndUpdate).not.toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ $pull: expect.anything() })
    );
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ lastLogoutAt: expect.any(Date) })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('removes no session when the token carries no jti', async () => {
    const token = jwt.sign({ userId: USER_ID }, TEST_SECRET);

    await getLogoutHandler()(
      makeReq({ user: authedUser, headers: { authorization: `Bearer ${token}` } }),
      makeRes()
    );

    expect(User.findByIdAndUpdate).not.toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ $pull: expect.anything() })
    );
  });

  it('still returns success and clears the cookie when the bookkeeping writes fail', async () => {
    const token = jwt.sign({ userId: USER_ID, jti: 'session-1' }, TEST_SECRET);
    (User.findByIdAndUpdate as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await getLogoutHandler()(
      makeReq({ user: authedUser, headers: { authorization: `Bearer ${token}` } }),
      res
    );

    expect(res.clearCookie).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'Logged out successfully' })
    );
  });
});
