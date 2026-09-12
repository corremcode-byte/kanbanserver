/**
 * Account-state / authentication interaction, and the downstream middleware
 * that consumes authenticate()'s req.user.
 *
 * Every test names the actor and the target account explicitly, and covers both
 * the allow and the deny path. These are regression locks: if a future change
 * altered what authenticate() attaches, or which fields the gate middlewares
 * read, these tests fail rather than silently passing.
 */

import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import {
  authenticate,
  requireActiveUser,
  requireEmailVerified,
  requireManagerOrAdmin,
  requireAdmin,
  requireSuperAdmin,
  authorize,
  getCurrentUserId,
  requireOwnershipOrAdmin,
  AuthenticatedRequest,
} from '../auth';

const TEST_SECRET = 'test-jwt-secret-for-account-state';
const ACTOR_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';

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

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeStoredUser(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => ACTOR_ID },
    email: 'actor@example.com',
    displayName: 'Actor',
    role: 'member',
    isActive: true,
    emailVerified: true,
    activeSessions: [] as any[],
    ...overrides,
  };
}

/** Runs the real authenticate middleware and returns the populated request. */
async function authenticateActor(storedUser: any): Promise<AuthenticatedRequest> {
  (User.findById as jest.Mock).mockResolvedValue(storedUser);
  const req = {
    headers: { authorization: `Bearer ${jwt.sign({ userId: ACTOR_ID }, TEST_SECRET)}` },
    cookies: {},
  } as AuthenticatedRequest;
  await authenticate(req, makeRes(), jest.fn());
  return req;
}

describe('authenticate — what it attaches to req.user', () => {
  it('attaches exactly six fields, omitting isActive and emailVerified', async () => {
    const req = await authenticateActor(makeStoredUser());

    expect(Object.keys(req.user).sort()).toEqual(
      ['_id', 'displayName', 'email', 'isManager', 'isSuperAdmin', 'role'].sort()
    );
    expect(req.user.isActive).toBeUndefined();
    expect(req.user.emailVerified).toBeUndefined();
  });

  it('omits those fields even when the stored record carries them as true', async () => {
    const req = await authenticateActor(makeStoredUser({ isActive: true, emailVerified: true }));

    expect('isActive' in req.user).toBe(false);
    expect('emailVerified' in req.user).toBe(false);
  });
});

describe('requireActiveUser — downstream of authenticate', () => {
  it('denies an unauthenticated request', () => {
    const res = makeRes();
    const next = jest.fn();

    requireActiveUser({} as AuthenticatedRequest, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Authentication required');
  });

  // FINDING (corroborates Batch 1, documented not fixed): authenticate never
  // sets isActive on req.user, so this gate rejects every request that reaches
  // it — including one from a fully active account. It is unreachable today
  // only because no route mounts it (see authRouteWiring.test.ts).
  it('denies an active account authenticated through the real middleware', async () => {
    const req = await authenticateActor(makeStoredUser({ isActive: true }));
    const res = makeRes();
    const next = jest.fn();

    requireActiveUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Account is deactivated');
  });

  it('allows only when isActive is set on req.user by something other than authenticate', () => {
    const req = { user: { _id: ACTOR_ID, role: 'member', isActive: true } } as AuthenticatedRequest;
    const res = makeRes();
    const next = jest.fn();

    requireActiveUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('denies when isActive is explicitly false', () => {
    const req = { user: { _id: ACTOR_ID, isActive: false } } as AuthenticatedRequest;
    const res = makeRes();
    const next = jest.fn();

    requireActiveUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireEmailVerified — downstream of authenticate', () => {
  it('denies an unauthenticated request', () => {
    const res = makeRes();
    const next = jest.fn();

    requireEmailVerified({} as AuthenticatedRequest, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // Same defect shape as requireActiveUser.
  it('denies a verified account authenticated through the real middleware', async () => {
    const req = await authenticateActor(makeStoredUser({ emailVerified: true }));
    const res = makeRes();
    const next = jest.fn();

    requireEmailVerified(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Email verification required');
  });

  it('allows when emailVerified is present and true', () => {
    const req = { user: { _id: ACTOR_ID, emailVerified: true } } as AuthenticatedRequest;
    const next = jest.fn();

    requireEmailVerified(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('role gates consume the flags authenticate does attach', () => {
  it('requireManagerOrAdmin allows manager, admin and superadmin', async () => {
    for (const role of ['manager', 'admin', 'superadmin']) {
      const req = await authenticateActor(makeStoredUser({ role }));
      const next = jest.fn();
      requireManagerOrAdmin(req, makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('requireManagerOrAdmin denies an ordinary member', async () => {
    const req = await authenticateActor(makeStoredUser({ role: 'member' }));
    const res = makeRes();
    const next = jest.fn();

    requireManagerOrAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Manager or Admin access required');
  });

  it('requireAdmin denies a manager but allows admin and superadmin', async () => {
    const manager = await authenticateActor(makeStoredUser({ role: 'manager' }));
    const denied = makeRes();
    requireAdmin(manager, denied, jest.fn());
    expect(denied.status).toHaveBeenCalledWith(403);

    for (const role of ['admin', 'superadmin']) {
      const req = await authenticateActor(makeStoredUser({ role }));
      const next = jest.fn();
      requireAdmin(req, makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('requireSuperAdmin allows only superadmin', async () => {
    for (const role of ['member', 'manager', 'admin']) {
      const req = await authenticateActor(makeStoredUser({ role }));
      const res = makeRes();
      requireSuperAdmin(req, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(403);
      expect(payloadOf(res).message).toBe('Super Admin access required');
    }

    const superadmin = await authenticateActor(makeStoredUser({ role: 'superadmin' }));
    const next = jest.fn();
    requireSuperAdmin(superadmin, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('every role gate denies an unauthenticated request with 401', () => {
    for (const gate of [requireManagerOrAdmin, requireAdmin, requireSuperAdmin]) {
      const res = makeRes();
      const next = jest.fn();
      gate({} as AuthenticatedRequest, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('a forged role claim in the token does not satisfy a role gate', async () => {
    // Actor forges role: superadmin; the stored account is a member.
    (User.findById as jest.Mock).mockResolvedValue(makeStoredUser({ role: 'member' }));
    const req = {
      headers: {
        authorization: `Bearer ${jwt.sign({ userId: ACTOR_ID, role: 'superadmin' }, TEST_SECRET)}`,
      },
      cookies: {},
    } as AuthenticatedRequest;
    await authenticate(req, makeRes(), jest.fn());

    const res = makeRes();
    const next = jest.fn();
    requireSuperAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('authorize(roles)', () => {
  it('allows a role in the list and denies one outside it', async () => {
    const member = await authenticateActor(makeStoredUser({ role: 'member' }));

    const allowed = jest.fn();
    authorize(['member', 'manager'])(member, makeRes(), allowed);
    expect(allowed).toHaveBeenCalledTimes(1);

    const res = makeRes();
    const denied = jest.fn();
    authorize(['admin'])(member, res, denied);
    expect(denied).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Insufficient permissions');
  });

  it('denies everything when the allowed list is empty', async () => {
    const req = await authenticateActor(makeStoredUser({ role: 'superadmin' }));
    const res = makeRes();
    const next = jest.fn();

    authorize([])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('denies an unauthenticated request with 401', () => {
    const res = makeRes();
    const next = jest.fn();

    authorize(['member'])({} as AuthenticatedRequest, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireOwnershipOrAdmin', () => {
  it('allows the owner of the resource', async () => {
    const req = await authenticateActor(makeStoredUser());
    const next = jest.fn();

    requireOwnershipOrAdmin(ACTOR_ID)(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a different user targeting someone else’s resource', async () => {
    const req = await authenticateActor(makeStoredUser());
    const res = makeRes();
    const next = jest.fn();

    requireOwnershipOrAdmin(OTHER_ID)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied');
  });

  // The production comment states admin no longer bypasses ownership; this
  // locks that in so a future change cannot silently reintroduce the bypass.
  it('denies even a superadmin who does not own the resource', async () => {
    const req = await authenticateActor(makeStoredUser({ role: 'superadmin' }));
    const res = makeRes();
    const next = jest.fn();

    requireOwnershipOrAdmin(OTHER_ID)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('denies an unauthenticated request', () => {
    const res = makeRes();
    const next = jest.fn();

    requireOwnershipOrAdmin(ACTOR_ID)({} as AuthenticatedRequest, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('getCurrentUserId', () => {
  it('returns the authenticated id as a string', async () => {
    const req = await authenticateActor(makeStoredUser());

    expect(getCurrentUserId(req)).toBe(ACTOR_ID);
  });

  it('returns null for an unauthenticated request', () => {
    expect(getCurrentUserId({} as AuthenticatedRequest)).toBeNull();
  });
});
