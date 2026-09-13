/**
 * JWT and session-enforcement edge cases beyond the core paths covered in
 * Batch 1 (src/middleware/__tests__/auth.test.ts). Nothing here repeats a
 * Batch 1 assertion; each test targets a distinct token-shape, claim or
 * multi-session behaviour.
 *
 * Actor in every test is the bearer of the token; the target is the account the
 * token names. Positive and negative paths are both exercised.
 */

import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { authenticate, optionalAuth, AuthenticatedRequest } from '../auth';

const TEST_SECRET = 'test-jwt-secret-for-token-edge-cases';
const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439022';

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

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function sign(payload: object, secret = TEST_SECRET, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, secret, options);
}

function makeUser(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    activeSessions: [] as any[],
    ...overrides,
  };
}

async function run(req: AuthenticatedRequest) {
  const res = makeRes();
  const next = jest.fn();
  await authenticate(req, res, next);
  return { res, next };
}

beforeEach(() => {
  (User.findById as jest.Mock).mockResolvedValue(makeUser());
});

describe('token extraction — empty and degenerate values', () => {
  it('treats an empty auth_token cookie as no cookie and falls back to the header', async () => {
    const req = makeReq({
      cookies: { auth_token: '' },
      headers: { authorization: `Bearer ${sign({ userId: USER_ID })}` },
    } as any);

    const { next } = await run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(User.findById).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects an Authorization header of exactly "Bearer " with an empty token', async () => {
    const { res, next } = await run(makeReq({ headers: { authorization: 'Bearer ' } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Authorization token required');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a bare "Bearer" with no separator', async () => {
    const { res, next } = await run(makeReq({ headers: { authorization: 'Bearer' } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Authorization token required');
  });

  it('is case-sensitive about the Bearer scheme — "bearer" is not accepted', async () => {
    const { res, next } = await run(
      makeReq({ headers: { authorization: `bearer ${sign({ userId: USER_ID })}` } } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Authorization token required');
  });

  it('rejects a whitespace-only cookie token as an invalid token, not a missing one', async () => {
    const { res, next } = await run(makeReq({ cookies: { auth_token: '   ' } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    // A present-but-garbage cookie reaches jwt.verify and fails there.
    expect(payloadOf(res).message).toBe('Invalid token');
  });

  it('takes only the second whitespace-separated segment of the header', async () => {
    const token = sign({ userId: USER_ID });
    const { next } = await run(
      makeReq({ headers: { authorization: `Bearer ${token} extra-garbage` } } as any)
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('token claims — required, missing and unexpected', () => {
  it('rejects a token whose payload is an empty object', async () => {
    const { res, next } = await run(makeReq({ headers: { authorization: `Bearer ${sign({})}` } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Invalid token');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose userId is an empty string', async () => {
    const { res, next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: '' })}` } } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose userId is null', async () => {
    const { res, next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: null })}` } } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('passes a non-string userId straight to the database lookup', async () => {
    // Documents that the middleware does no shape validation on userId — the
    // value is forwarded to findById as-is.
    (User.findById as jest.Mock).mockResolvedValue(null);
    const { res } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: { $ne: null } })}` } } as any)
    );

    expect(User.findById).toHaveBeenCalledWith({ $ne: null });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('ignores unexpected extra claims and still authenticates', async () => {
    const req = makeReq({
      headers: {
        authorization: `Bearer ${sign({
          userId: USER_ID,
          role: 'superadmin',
          isActive: false,
          isSuperAdmin: true,
          permissions: { canManageAllProjects: true },
        })}`,
      },
    } as any);

    const { next } = await run(req);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('derives identity from the database record, never from claims in the token', async () => {
    // Actor forges elevated claims; the middleware must use the stored user.
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ role: 'member' }));
    const req = makeReq({
      headers: {
        authorization: `Bearer ${sign({
          userId: USER_ID,
          role: 'superadmin',
          email: 'attacker@evil.test',
          displayName: 'Attacker',
        })}`,
      },
    } as any);

    await run(req);

    expect(req.user.role).toBe('member');
    expect(req.user.isSuperAdmin).toBe(false);
    expect(req.user.email).toBe('user@example.com');
    expect(req.user.displayName).toBe('Test User');
  });

  it('rejects an unsigned alg:none token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ userId: USER_ID })).toString('base64url');
    const unsigned = `${header}.${body}.`;

    const { res, next } = await run(makeReq({ headers: { authorization: `Bearer ${unsigned}` } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Invalid token');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose payload is valid JSON but not an object', async () => {
    const { res, next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign('a-plain-string' as any)}` } } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts a token that is still inside its expiry window', async () => {
    const { next } = await run(
      makeReq({
        headers: { authorization: `Bearer ${sign({ userId: USER_ID }, TEST_SECRET, { expiresIn: '1h' })}` },
      } as any)
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a token with no exp claim at all — expiry is optional', async () => {
    // Password login mints exactly this shape (no expiresIn), so this locks in
    // that such tokens remain valid indefinitely.
    const token = sign({ userId: USER_ID });
    expect((jwt.decode(token) as any).exp).toBeUndefined();

    const { next } = await run(makeReq({ headers: { authorization: `Bearer ${token}` } } as any));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a token that is not yet valid (nbf in the future)', async () => {
    const notYet = sign({ userId: USER_ID, nbf: Math.floor(Date.now() / 1000) + 3600 });

    const { res, next } = await run(makeReq({ headers: { authorization: `Bearer ${notYet}` } } as any));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('multi-session enforcement', () => {
  const desktopJti = 'desktop-session-jti';
  const mobileJti = 'mobile-session-jti';

  function userWithBothSessions() {
    return makeUser({
      activeSessions: [
        { jti: desktopJti, deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'd' },
        { jti: mobileJti, deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'm' },
      ],
    });
  }

  it('accepts each of two concurrent sessions independently', async () => {
    (User.findById as jest.Mock).mockResolvedValue(userWithBothSessions());

    for (const jti of [desktopJti, mobileJti]) {
      const { res, next } = await run(
        makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti })}` } } as any)
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('matches the exact jti — a near-miss value is rejected', async () => {
    (User.findById as jest.Mock).mockResolvedValue(userWithBothSessions());

    const { res, next } = await run(
      makeReq({
        headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: `${desktopJti}x` })}` },
      } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Session expired or logged in from another device');
  });

  it('removing one session leaves the other working', async () => {
    // Simulates logout of the desktop session only.
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({
        activeSessions: [{ jti: mobileJti, deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'm' }],
      })
    );

    const revoked = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: desktopJti })}` } } as any)
    );
    expect(revoked.next).not.toHaveBeenCalled();
    expect(revoked.res.status).toHaveBeenCalledWith(401);

    const survivor = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: mobileJti })}` } } as any)
    );
    expect(survivor.next).toHaveBeenCalledTimes(1);
  });

  it('rejects a jti that belongs to a different user’s session list', async () => {
    // Actor holds a token whose jti was issued to another account; the session
    // list consulted is the one on the account the token names.
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({ activeSessions: [{ jti: 'sessions-of-user-a', deviceType: 'desktop' }] })
    );

    const { res, next } = await run(
      makeReq({
        headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: 'sessions-of-user-b' })}` },
      } as any)
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects every session once the list is emptied', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ activeSessions: [] }));

    for (const jti of [desktopJti, mobileJti]) {
      const { res, next } = await run(
        makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti })}` } } as any)
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('checks account state before the session list — a deactivated user is 403, not 401', async () => {
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({ isActive: false, activeSessions: [] })
    );

    const { res } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: 'anything' })}` } } as any)
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Account is deactivated');
  });

  // REGRESSION LOCK for the Batch 1 finding: session validation is gated on
  // `if (decoded.jti)`. A token minted without a jti bypasses the check even
  // when the account has an explicit, non-empty session list — so it survives
  // logout and device eviction. Documented, not fixed.
  it('accepts a jti-less token even while the account has other live sessions', async () => {
    (User.findById as jest.Mock).mockResolvedValue(userWithBothSessions());

    const { res, next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID })}` } } as any)
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts a jti-less token even after every session has been revoked', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ activeSessions: [] }));

    const { next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID })}` } } as any)
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('treats an empty-string jti as absent and skips session validation', async () => {
    (User.findById as jest.Mock).mockResolvedValue(userWithBothSessions());

    const { next } = await run(
      makeReq({ headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: '' })}` } } as any)
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('optionalAuth — token edge cases', () => {
  it('continues anonymously for an empty Bearer value without consulting the database', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer ' } } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('continues anonymously for an unsigned alg:none token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ userId: USER_ID })).toString('base64url');
    const req = makeReq({ headers: { authorization: `Bearer ${header}.${body}.` } } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('continues anonymously for an expired token rather than erroring', async () => {
    const expired = sign({ userId: USER_ID }, TEST_SECRET, { expiresIn: '-1h' });
    const req = makeReq({ headers: { authorization: `Bearer ${expired}` } } as any);
    const res = makeRes();
    const next = jest.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('does not populate req.user from token claims when the payload lacks userId', async () => {
    const req = makeReq({ headers: { authorization: `Bearer ${sign({ email: 'a@b.c' })}` } } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(User.findById).not.toHaveBeenCalled();
  });

  // REGRESSION LOCK for the Batch 1 finding: optionalAuth performs no session
  // validation at all. Here the account has live sessions and the token names
  // none of them, yet the request is still authenticated. Documented, not fixed.
  it('authenticates a token whose jti is absent from a non-empty session list', async () => {
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({ activeSessions: [{ jti: 'a-different-session', deviceType: 'desktop' }] })
    );
    const req = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: USER_ID, jti: 'revoked-jti' })}` },
    } as any);
    const next = jest.fn();

    await optionalAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
    expect(req.user._id).toBe(USER_ID);
  });

  it('grants the same role flags as authenticate for an equivalent token', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ role: 'superadmin' }));
    const optional = makeReq({
      headers: { authorization: `Bearer ${sign({ userId: OTHER_USER_ID })}` },
    } as any);

    await optionalAuth(optional, makeRes(), jest.fn());

    expect(optional.user.isSuperAdmin).toBe(true);
    expect(optional.user.isManager).toBe(true);
  });
});
