jest.mock('../../models', () => ({
  User: { findById: jest.fn(), findByIdAndUpdate: jest.fn(), findOne: jest.fn() },
  Task: { find: jest.fn() },
  Project: { find: jest.fn() },
}));

jest.mock('../../models/AuditLog', () => ({
  AuditLog: { logSystemEvent: jest.fn() },
}));

jest.mock('../../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendPasswordResetEmail: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { deactivateAccount, deleteAccount, getCurrentUser } from '../authController';

const USER_ID = '507f1f77bcf86cd799439011';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any = {}, user: any = { _id: USER_ID }) {
  return { body, user, headers: {} } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeUpdatedUser(overrides: Record<string, any> = {}) {
  return {
    _id: USER_ID,
    email: 'user@example.com',
    displayName: 'Test User',
    isActive: false,
    activeSessions: [
      { jti: 'desktop-session', deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'ua' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
});

describe('deactivateAccount', () => {
  it('rejects an unauthenticated request without touching the database', async () => {
    const res = makeRes();

    await deactivateAccount(makeReq({}, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not authenticated' });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('flips isActive to false for the caller and returns the updated document', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser());
    const res = makeRes();

    await deactivateAccount(makeReq(), res);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, { isActive: false }, { new: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe('Account deactivated successfully');
  });

  it('acts only on the caller, ignoring any userId supplied in the body', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser());

    await deactivateAccount(makeReq({ userId: 'someone-elses-id', _id: 'someone-elses-id' }), makeRes());

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, expect.anything(), expect.anything());
    expect(User.findByIdAndUpdate).not.toHaveBeenCalledWith(
      'someone-elses-id',
      expect.anything(),
      expect.anything()
    );
  });

  it('returns 404 when the account no longer exists', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deactivateAccount(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('is idempotent — deactivating an already-inactive account still succeeds', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser({ isActive: false }));
    const first = makeRes();
    const second = makeRes();

    await deactivateAccount(makeReq(), first);
    await deactivateAccount(makeReq(), second);

    expect(first.status).toHaveBeenCalledWith(200);
    expect(second.status).toHaveBeenCalledWith(200);
    expect(User.findByIdAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('returns 500 without leaking internals when the update fails', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockRejectedValue(new Error('mongo timeout on shard-3'));
    const res = makeRes();

    await deactivateAccount(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to deactivate account' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('shard-3');
  });

  it('returns no account payload that could echo credentials', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(
      makeUpdatedUser({ password: '$2a$10$somehash', plainPassword: 'encrypted-blob' })
    );
    const res = makeRes();

    await deactivateAccount(makeReq(), res);

    const serialized = JSON.stringify(payloadOf(res));
    expect(payloadOf(res).data).toBeUndefined();
    expect(serialized).not.toContain('somehash');
    expect(serialized).not.toContain('plainPassword');
  });

  // FINDING (documented, not fixed): self-service deactivation requires no
  // password or other re-confirmation. Any context holding a valid token —
  // including a CSRF-style forced request or a borrowed unlocked session — can
  // deactivate the account outright.
  it('requires no password confirmation to deactivate', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser());
    const res = makeRes();

    await deactivateAccount(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // FINDING (documented, not fixed): deactivation never clears activeSessions.
  // Access is stopped only because authenticate() re-reads isActive on every
  // request; the stale jti list survives and would become live again the moment
  // the account is reactivated.
  it('leaves the stored activeSessions list untouched', async () => {
    const updated = makeUpdatedUser();
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(updated);

    await deactivateAccount(makeReq(), makeRes());

    const updatePayload = (User.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(updatePayload).toEqual({ isActive: false });
    expect(updatePayload).not.toHaveProperty('activeSessions');
    expect(updated.activeSessions).toHaveLength(1);
  });
});

describe('deleteAccount', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await deleteAccount(makeReq({}, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not authenticated' });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('is a soft delete — it deactivates rather than removing the document', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser());
    const res = makeRes();

    await deleteAccount(makeReq(), res);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, { isActive: false }, { new: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe('Account deleted successfully');
  });

  it('reports deletion to the caller even though the record is retained', async () => {
    // The message says "deleted" while the row survives with isActive:false —
    // worth locking in so the wording is not mistaken for a hard delete.
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(makeUpdatedUser());
    const res = makeRes();

    await deleteAccount(makeReq(), res);

    const updatePayload = (User.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(updatePayload).toEqual({ isActive: false });
    expect(payloadOf(res).message).toContain('deleted');
  });

  it('returns 404 when the account no longer exists', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteAccount(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('returns 500 when the update fails', async () => {
    (User.findByIdAndUpdate as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await deleteAccount(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to delete account' });
  });

  it('requires no password confirmation and clears no sessions', async () => {
    const updated = makeUpdatedUser();
    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue(updated);
    const res = makeRes();

    await deleteAccount(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((User.findByIdAndUpdate as jest.Mock).mock.calls[0][1]).not.toHaveProperty('activeSessions');
    expect(updated.activeSessions).toHaveLength(1);
  });
});

describe('getCurrentUser — credential exposure and account state', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getCurrentUser(makeReq({}, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a deleted account', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getCurrentUser(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('refuses a deactivated account with 403 even though the token was accepted', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      isActive: false,
      toObject: () => ({ _id: USER_ID, email: 'user@example.com', isActive: false }),
    });
    const res = makeRes();

    await getCurrentUser(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Account is deactivated' });
  });

  it('returns the profile for an active account', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      isActive: true,
      toObject: () => ({ _id: USER_ID, email: 'user@example.com', displayName: 'Test User', isActive: true }),
    });
    const res = makeRes();

    await getCurrentUser(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data).toMatchObject({ email: 'user@example.com', displayName: 'Test User' });
  });

  // FINDING (documented, not fixed): getCurrentUser serialises with
  // `user.toObject()`, which — unlike the model's own `toJSON()` — performs no
  // scrubbing. Nothing in the controller strips credentials; the response is
  // safe only because `password`/`plainPassword` carry `select: false` in the
  // schema. Any future change that selects those fields would leak them here.
  it('relies solely on schema-level select:false — toObject() passes credentials straight through', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      isActive: true,
      toObject: () => ({
        _id: USER_ID,
        email: 'user@example.com',
        isActive: true,
        password: '$2a$10$hashthatshouldneverleak',
        plainPassword: 'reversibly-encrypted-blob',
      }),
    });
    const res = makeRes();

    await getCurrentUser(makeReq(), res);

    // Documents the gap: the controller does not scrub, so anything the query
    // returns reaches the client verbatim.
    expect(payloadOf(res).data).toHaveProperty('password');
    expect(payloadOf(res).data).toHaveProperty('plainPassword');
  });

  it('returns 500 when the lookup throws', async () => {
    (User.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await getCurrentUser(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to get user' });
  });
});
