jest.mock('../../models', () => ({
  User: { findById: jest.fn(), findOne: jest.fn() },
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

// updatePassword resolves bcrypt through an inline require(); mocking the module
// lets each test decide whether the supplied current password matches.
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  genSalt: jest.fn(),
  hash: jest.fn(),
}));

import bcrypt from 'bcryptjs';
import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { updatePassword } from '../authController';

const USER_ID = '507f1f77bcf86cd799439011';
const CURRENT_PLAINTEXT = 'OldP@ssw0rd1';
const STORED_HASH = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO';
const NEW_STRONG = 'N3w!StrongPass';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any, user: any = { _id: USER_ID }) {
  return { body, user } as any;
}

function makeUserDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    displayName: 'Test User',
    password: STORED_HASH,
    isActive: true,
    activeSessions: [
      { jti: 'desktop-session', deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'ua' },
      { jti: 'mobile-session', deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'ua' },
    ] as any[],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** User.findById(...).select('+password') — chainable. */
function mockFindByIdResolves(doc: any) {
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
});

describe('updatePassword — authorization and input validation', () => {
  it('rejects an unauthenticated request with 401 before reading the body', async () => {
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not authenticated' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a request whose authenticated user carries no _id', async () => {
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }, {}), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('requires the current password', async () => {
    const res = makeRes();

    await updatePassword(makeReq({ newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Current password is required' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('requires the new password', async () => {
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'New password is required' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('returns 404 when the authenticated user no longer exists', async () => {
    mockFindByIdResolves(null);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('loads the password field explicitly, since the schema excludes it by default', async () => {
    const select = jest.fn().mockResolvedValue(makeUserDoc());
    (User.findById as jest.Mock).mockReturnValue({ select });

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), makeRes());

    expect(User.findById).toHaveBeenCalledWith(USER_ID);
    expect(select).toHaveBeenCalledWith('+password');
  });
});

describe('updatePassword — current-password verification', () => {
  it('rejects an incorrect current password without saving', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: 'WrongP@ss1', newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Current password is incorrect' });
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('compares the supplied current password against the stored hash', async () => {
    mockFindByIdResolves(makeUserDoc());

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), makeRes());

    expect(bcrypt.compare).toHaveBeenCalledWith(CURRENT_PLAINTEXT, STORED_HASH);
  });

  it('checks the current password before the same-password rule', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    const res = makeRes();

    // Both fields identical *and* wrong: the credential error must win, so a
    // caller cannot probe the same-password rule without knowing the password.
    await updatePassword(makeReq({ currentPassword: 'Guess@123', newPassword: 'Guess@123' }), res);

    expect(payloadOf(res).message).toBe('Current password is incorrect');
  });

  it('rejects reusing the current password as the new password', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: CURRENT_PLAINTEXT }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({
      success: false,
      message: 'New password must be different from your current password',
    });
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('updatePassword — new-password policy', () => {
  it('enforces the full complexity policy and reports the first violation', async () => {
    const cases: Array<[string, string]> = [
      ['Sh0rt!', 'At least 8 characters required'],
      ['alllowercase1!', 'At least one uppercase letter (A-Z)'],
      ['ALLUPPERCASE1!', 'At least one lowercase letter (a-z)'],
      ['NoDigitsHere!', 'At least one number (0-9)'],
      ['NoSpecialChar1', 'At least one special character (!@#$%^&*)'],
      ['Has Space1!', 'Must not contain spaces'],
      ['Password123!', 'Password is too common — choose something more unique'],
    ];

    for (const [weakPassword, expectedMessage] of cases) {
      const doc = makeUserDoc();
      mockFindByIdResolves(doc);
      const res = makeRes();

      await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: weakPassword }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe(expectedMessage);
      expect(doc.save).not.toHaveBeenCalled();
    }
  });

  it('rejects a new password exceeding the 64-character maximum', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(
      makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: `Abc123!${'a'.repeat(58)}` }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Maximum 64 characters allowed');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('blocks a new password derived from the account email', async () => {
    const doc = makeUserDoc({ email: 'jonathansmith@example.com' });
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: 'Jonathansmith1!' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Password must not be the same as your email address');
  });

  it('blocks a new password derived from the display name', async () => {
    const doc = makeUserDoc({ email: 'u@example.com', displayName: 'Jonathan Smith1!' });
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: 'Jonathansmith1!' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Password must not be the same as your name');
  });

  it('accepts a password sitting exactly on the 8-character minimum', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: 'Abc123!d' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });
});

describe('updatePassword — successful change', () => {
  it('assigns the raw new password and persists, leaving hashing to the pre-save hook', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(doc.password).toBe(NEW_STRONG);
    expect(doc.save).toHaveBeenCalledTimes(1);
    // The controller must not hash by hand — that is the model's job.
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns a bare success message with no user payload', async () => {
    mockFindByIdResolves(makeUserDoc());
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(payloadOf(res)).toEqual({
      success: true,
      message: 'Password updated successfully',
      data: undefined,
    });
  });

  it('never echoes the password, the hash, or plainPassword back to the client', async () => {
    mockFindByIdResolves(makeUserDoc());
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    const serialized = JSON.stringify(payloadOf(res));
    expect(serialized).not.toContain(NEW_STRONG);
    expect(serialized).not.toContain(CURRENT_PLAINTEXT);
    expect(serialized).not.toContain(STORED_HASH);
    expect(serialized).not.toContain('plainPassword');
  });

  it('writes a user_password_updated audit entry', async () => {
    mockFindByIdResolves(makeUserDoc());

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), makeRes());

    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'user_password_updated',
        metadata: expect.objectContaining({ userEmail: 'user@example.com' }),
      })
    );
  });

  it('records no password material in the audit metadata', async () => {
    mockFindByIdResolves(makeUserDoc());

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), makeRes());

    const entry = (AuditLog.logSystemEvent as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(NEW_STRONG);
    expect(serialized).not.toContain(CURRENT_PLAINTEXT);
  });

  it('still reports success when audit logging fails', async () => {
    const doc = makeUserDoc();
    mockFindByIdResolves(doc);
    (AuditLog.logSystemEvent as jest.Mock).mockRejectedValue(new Error('audit sink offline'));
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('updatePassword — failure handling', () => {
  it('returns 500 without leaking internals when the save fails', async () => {
    const doc = makeUserDoc({ save: jest.fn().mockRejectedValue(new Error('E11000 duplicate key on replica-1')) });
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to update password' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('replica-1');
  });

  it('returns 500 when the user lookup throws', async () => {
    (User.findById as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to update password' });
  });
});

describe('updatePassword — session consequences', () => {
  // SECURITY FINDING (documented, not fixed): changing the password leaves
  // user.activeSessions untouched, so every other logged-in device keeps a
  // working token. A user who changes their password because it was stolen
  // does not thereby evict the attacker. Contrast with logout, which does
  // $pull the jti. This test locks in today's behaviour.
  it('leaves every pre-existing session active after a successful password change', async () => {
    const doc = makeUserDoc();
    const sessionsBefore = doc.activeSessions.map((s: any) => s.jti);
    mockFindByIdResolves(doc);
    const res = makeRes();

    await updatePassword(makeReq({ currentPassword: CURRENT_PLAINTEXT, newPassword: NEW_STRONG }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.activeSessions.map((s: any) => s.jti)).toEqual(sessionsBefore);
    expect(doc.activeSessions).toHaveLength(2);
  });
});
