import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: {
    findById: jest.fn(),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { authenticate, optionalAuth, AuthenticatedRequest } from '../auth';

const TEST_SECRET = 'test-jwt-secret-for-middleware-suite';

// Silences the console.error diagnostics authenticate() writes on every failed
// verification, so a failing assertion is what stands out in the test output.
let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { headers: {}, cookies: {}, ...overrides } as AuthenticatedRequest;
}

function sign(payload: object, secret = TEST_SECRET, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, secret, options);
}

/** The shape User.findById resolves to — only the fields the middleware reads. */
function makeUser(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    email: 'user@example.com',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    activeSessions: [] as any[],
    ...overrides,
  };
}

/** Asserts an errorResponse(res, message, status) was produced. */
function expectError(res: any, status: number, message: string) {
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledWith({ success: false, message });
}

describe('authenticate', () => {
  describe('token extraction', () => {
    it('rejects a request with no cookie and no Authorization header', async () => {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Authorization token required');
      expect(User.findById).not.toHaveBeenCalled();
    });

    it('accepts a valid token from the Authorization Bearer header', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser());
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(req.user).toMatchObject({ _id: '507f1f77bcf86cd799439011', email: 'user@example.com' });
    });

    it('accepts a valid token from the auth_token cookie', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser());
      const req = makeReq({ cookies: { auth_token: sign({ userId: '507f1f77bcf86cd799439011' }) } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
    });

    it('prefers the cookie over the Authorization header when both are present', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser());
      const req = makeReq({
        cookies: { auth_token: sign({ userId: 'cookie-user' }) },
        headers: { authorization: `Bearer ${sign({ userId: 'header-user' })}` },
      } as any);
      const res = makeRes();

      await authenticate(req, res, jest.fn());

      expect(User.findById).toHaveBeenCalledWith('cookie-user');
    });

    it('ignores an Authorization header that is not a Bearer scheme', async () => {
      const req = makeReq({
        headers: { authorization: `Basic ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Authorization token required');
    });
  });

  describe('token validation', () => {
    it('rejects a structurally malformed token', async () => {
      const req = makeReq({ headers: { authorization: 'Bearer not-a-jwt' } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Invalid token');
    });

    it('rejects a well-formed token signed with a different secret', async () => {
      const forged = sign({ userId: '507f1f77bcf86cd799439011' }, 'attacker-secret');
      const req = makeReq({ headers: { authorization: `Bearer ${forged}` } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Invalid token');
      expect(User.findById).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      const expired = sign({ userId: '507f1f77bcf86cd799439011' }, TEST_SECRET, { expiresIn: '-1h' });
      const req = makeReq({ headers: { authorization: `Bearer ${expired}` } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Invalid token');
    });

    it('rejects a validly-signed token whose payload carries no userId', async () => {
      const req = makeReq({ headers: { authorization: `Bearer ${sign({ email: 'a@b.c' })}` } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Invalid token');
      expect(User.findById).not.toHaveBeenCalled();
    });
  });

  describe('user state', () => {
    it('returns 404 when the token references a deleted / nonexistent user', async () => {
      (User.findById as jest.Mock).mockResolvedValue(null);
      const req = makeReq({ headers: { authorization: `Bearer ${sign({ userId: 'gone' })}` } } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 404, 'User not found');
    });

    it('returns 403 for a deactivated account even with an otherwise valid token', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser({ isActive: false }));
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 403, 'Account is deactivated');
      expect(req.user).toBeUndefined();
    });

    it('rejects with 401 when the database lookup throws', async () => {
      (User.findById as jest.Mock).mockRejectedValue(new Error('connection lost'));
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Invalid token');
    });
  });

  describe('session (jti) validation', () => {
    it('accepts a token whose jti is listed in the user activeSessions', async () => {
      (User.findById as jest.Mock).mockResolvedValue(
        makeUser({ activeSessions: [{ jti: 'session-1', deviceType: 'desktop' }] })
      );
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011', jti: 'session-1' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects a token whose jti is no longer in activeSessions (logged out / evicted by another device)', async () => {
      (User.findById as jest.Mock).mockResolvedValue(
        makeUser({ activeSessions: [{ jti: 'other-session', deviceType: 'mobile' }] })
      );
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011', jti: 'revoked' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Session expired or logged in from another device');
      expect(req.user).toBeUndefined();
    });

    it('rejects a jti-bearing token when the user has no activeSessions at all', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser({ activeSessions: undefined }));
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011', jti: 'session-1' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expectError(res, 401, 'Session expired or logged in from another device');
    });

    // SECURITY NOTE (documented, not fixed): the session check is gated on
    // `if (decoded.jti)`. A token minted without a jti therefore skips session
    // validation entirely and cannot be revoked by logout or device eviction.
    // This test locks in the behaviour as it exists today.
    it('skips session validation entirely for a token that carries no jti', async () => {
      (User.findById as jest.Mock).mockResolvedValue(
        makeUser({ activeSessions: [{ jti: 'some-other-session', deviceType: 'desktop' }] })
      );
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);
      const res = makeRes();
      const next = jest.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('req.user projection', () => {
    it('exposes only the whitelisted identity fields, never the password hash', async () => {
      (User.findById as jest.Mock).mockResolvedValue(
        makeUser({ password: 'hashed-secret', passkey: '123456', someInternalField: 'x' })
      );
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);

      await authenticate(req, makeRes(), jest.fn());

      expect(Object.keys(req.user).sort()).toEqual(
        ['_id', 'displayName', 'email', 'isManager', 'isSuperAdmin', 'role'].sort()
      );
      expect(req.user.password).toBeUndefined();
      expect(req.user.passkey).toBeUndefined();
    });

    it('stringifies the Mongo _id rather than passing the ObjectId through', async () => {
      (User.findById as jest.Mock).mockResolvedValue(makeUser());
      const req = makeReq({
        headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
      } as any);

      await authenticate(req, makeRes(), jest.fn());

      expect(typeof req.user._id).toBe('string');
      expect(req.user._id).toBe('507f1f77bcf86cd799439011');
    });

    it('derives isManager/isSuperAdmin from the role for every role', async () => {
      const cases: Array<[string, boolean, boolean]> = [
        ['member', false, false],
        ['manager', true, false],
        ['admin', true, false],
        ['superadmin', true, true],
      ];

      for (const [role, isManager, isSuperAdmin] of cases) {
        (User.findById as jest.Mock).mockResolvedValue(makeUser({ role }));
        const req = makeReq({
          headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
        } as any);

        await authenticate(req, makeRes(), jest.fn());

        expect(req.user.role).toBe(role);
        expect(req.user.isManager).toBe(isManager);
        expect(req.user.isSuperAdmin).toBe(isSuperAdmin);
      }
    });
  });
});

describe('optionalAuth', () => {
  it('continues anonymously when no token is supplied', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches the user for a valid Bearer token', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ role: 'admin' }));
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
    } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ email: 'user@example.com', role: 'admin', isManager: true });
  });

  it('attaches the user for a valid cookie token', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser());
    const req = makeReq({ cookies: { auth_token: sign({ userId: '507f1f77bcf86cd799439011' }) } } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
  });

  it('swallows an invalid token and continues anonymously instead of erroring', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer garbage.token.value' } } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('does not attach a deactivated user', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ isActive: false }));
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
    } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('continues anonymously when the token references a nonexistent user', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: 'gone' })}` },
    } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('continues anonymously when the database lookup throws', async () => {
    (User.findById as jest.Mock).mockRejectedValue(new Error('connection lost'));
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011' })}` },
    } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  // SECURITY NOTE (documented, not fixed): unlike authenticate(), optionalAuth
  // never checks decoded.jti against user.activeSessions. A token revoked by
  // logout or evicted by a same-device login is still honoured on any route
  // mounted with optionalAuth — including POST /api/auth/logout itself.
  it('honours a token whose session has already been revoked (no jti check)', async () => {
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({ activeSessions: [] })
    );
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: '507f1f77bcf86cd799439011', jti: 'revoked-session' })}` },
    } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
  });
});
