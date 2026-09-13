/**
 * Cross-cutting authentication security regressions:
 *   - password-reset token edge cases not already covered in Batch 2
 *   - login error-branch behaviour
 *   - auth response data-exposure locks
 *
 * Batch 2 already covers the main reset flow, the weak-password policy gap and
 * the replay finding; nothing here repeats those assertions.
 */

import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: { findById: jest.fn(), findOne: jest.fn() },
  Task: { find: jest.fn() },
  Project: { find: jest.fn() },
}));

jest.mock('../../models/AuditLog', () => ({
  AuditLog: { logSystemEvent: jest.fn(), logAction: jest.fn() },
}));

jest.mock('../../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendPasswordResetEmail: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { emailService } from '../../services/emailService';
import { login, resetPassword, requestPasswordReset, getCurrentUser } from '../authController';

const TEST_SECRET = 'test-jwt-secret-for-security-regression';
const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.APP_URL = 'https://app.test.example';
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any = {}, overrides: any = {}) {
  return { body, headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' }, ...overrides } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeUserDoc(overrides: Record<string, any> = {}): Record<string, any> {
  const doc: any = {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    username: 'testuser',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    // Only `password` is pulled back by login's .select('+password'); passkey,
    // chatLockPasskey and currentChallenge carry select:false and stay absent.
    password: '$2a$10$storedhash000000000000000000000000000000000000000000000',
    plainPassword: 'reversibly-encrypted-blob',
    activeSessions: [] as any[],
    comparePassword: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  // The real model's toJSON strips password and plainPassword (Batch 2).
  doc.toJSON = jest.fn(() => {
    const { password, plainPassword, comparePassword, save, toJSON, ...rest } = doc;
    return rest;
  });
  return doc;
}

function mockLoginFindOne(doc: any) {
  (User.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

function mockFindByIdSelect(doc: any) {
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

function makeResetToken(overrides: Record<string, any> = {}, options: jwt.SignOptions = {}) {
  return jwt.sign(
    { userId: USER_ID, email: 'user@example.com', type: 'password-reset', ...overrides },
    TEST_SECRET,
    options
  );
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  (emailService.sendPasswordResetEmail as jest.Mock).mockResolvedValue(true);
  mockFindByIdSelect({ passkey: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset token edge cases (beyond Batch 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('resetPassword — token shape edge cases', () => {
  it('rejects an alg:none reset token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ userId: USER_ID, type: 'password-reset' })
    ).toString('base64url');
    const res = makeRes();

    await resetPassword(makeReq({ token: `${header}.${body}.`, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid or expired reset token');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose signature has been swapped for another token’s', async () => {
    const real = makeResetToken();
    const forged = makeResetToken({ userId: OTHER_ID }, {});
    const spliced = `${forged.split('.').slice(0, 2).join('.')}.${real.split('.')[2]}`;
    const res = makeRes();

    await resetPassword(makeReq({ token: spliced, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token whose type claim is null rather than treating it as absent', async () => {
    const res = makeRes();

    await resetPassword(
      makeReq({ token: makeResetToken({ type: null }), newPassword: 'N3w!StrongPass' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid reset token');
  });

  it('rejects a type claim that differs only in case', async () => {
    const res = makeRes();

    await resetPassword(
      makeReq({ token: makeResetToken({ type: 'Password-Reset' }), newPassword: 'N3w!StrongPass' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid reset token');
  });

  it('accepts a token one second before expiry and rejects it one second after', async () => {
    const now = Math.floor(Date.now() / 1000);

    const almostExpired = jwt.sign(
      { userId: USER_ID, type: 'password-reset', iat: now - 3599, exp: now + 1 },
      TEST_SECRET
    );
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const valid = makeRes();
    await resetPassword(makeReq({ token: almostExpired, newPassword: 'N3w!StrongPass' }), valid);
    expect(valid.status).toHaveBeenCalledWith(200);

    const justExpired = jwt.sign(
      { userId: USER_ID, type: 'password-reset', iat: now - 3601, exp: now - 1 },
      TEST_SECRET
    );
    const expired = makeRes();
    await resetPassword(makeReq({ token: justExpired, newPassword: 'N3w!StrongPass' }), expired);
    expect(expired.status).toHaveBeenCalledWith(400);
    expect(payloadOf(expired).message).toBe('Invalid or expired reset token');
  });

  it('resolves the account from userId alone — a mismatched email claim is ignored', async () => {
    // The token's email claim points at a different account than its userId.
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await resetPassword(
      makeReq({
        token: makeResetToken({ email: 'someone-else@example.com' }),
        newPassword: 'N3w!StrongPass',
      }),
      res
    );

    expect(User.findById).toHaveBeenCalledWith(USER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a non-string token value without throwing', async () => {
    for (const token of [12345, { sub: USER_ID }, ['a', 'b'], true]) {
      const res = makeRes();
      await resetPassword(makeReq({ token, newPassword: 'N3w!StrongPass' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('checks the password length before the token, so a short password hides token validity', async () => {
    // An attacker probing with a short password learns nothing about the token.
    const res = makeRes();

    await resetPassword(makeReq({ token: 'totally-invalid-token', newPassword: 'abc' }), res);

    expect(payloadOf(res).message).toBe('Password must be at least 6 characters long');
  });

  it('leaves activeSessions untouched when the reset fails on an invalid token', async () => {
    const doc = makeUserDoc({
      activeSessions: [{ jti: 'live-session', deviceType: 'desktop' }],
    });
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await resetPassword(makeReq({ token: 'bad-token', newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.activeSessions).toHaveLength(1);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('requestPasswordReset — issuance edge cases', () => {
  it('issues a distinct token on each request for the same account', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());

    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      (emailService.sendPasswordResetEmail as jest.Mock).mockClear();
      await requestPasswordReset(makeReq({ email: 'user@example.com' }), makeRes());
      const { resetLink } = (emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0][1];
      tokens.push(new URL(resetLink).searchParams.get('token')!);
      await new Promise((r) => setTimeout(r, 1100)); // iat has one-second resolution
    }

    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('does not invalidate a previously issued token when a new one is requested', async () => {
    // Both tokens verify — there is no server-side token store to revoke from.
    const first = makeResetToken({}, { expiresIn: '1h' });
    const second = makeResetToken({}, { expiresIn: '1h' });

    expect(() => jwt.verify(first, TEST_SECRET)).not.toThrow();
    expect(() => jwt.verify(second, TEST_SECRET)).not.toThrow();

    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();
    await resetPassword(makeReq({ token: first, newPassword: 'N3w!StrongPass' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sends the reset link to the normalized address, not the raw input', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ email: 'user@example.com' }));

    await requestPasswordReset(makeReq({ email: '  USER@Example.com  ' }), makeRes());

    expect((emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0][0]).toBe(
      'user@example.com'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login error branches
// ─────────────────────────────────────────────────────────────────────────────

describe('login — error branches and account state', () => {
  it('returns the same 401 body for an unknown account and a wrong password', async () => {
    mockLoginFindOne(null);
    const unknown = makeRes();
    await login(makeReq({ email: 'nobody@example.com', password: 'Secret123!' }), unknown);

    mockLoginFindOne(makeUserDoc({ comparePassword: jest.fn().mockResolvedValue(false) }));
    const wrongPassword = makeRes();
    await login(makeReq({ email: 'user@example.com', password: 'Wrong123!' }), wrongPassword);

    expect(payloadOf(unknown)).toEqual(payloadOf(wrongPassword));
    expect(unknown.status.mock.calls).toEqual(wrongPassword.status.mock.calls);
  });

  it('cannot be bypassed by supplying an isActive override in the body', async () => {
    // The isActive:true filter is built server-side; body fields do not reach it.
    mockLoginFindOne(null);
    const res = makeRes();

    await login(
      makeReq({ email: 'user@example.com', password: 'Secret123!', isActive: false }),
      res
    );

    expect(User.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true })
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('treats a non-string email defensively rather than crashing', async () => {
    const res = makeRes();

    await login(makeReq({ email: { $ne: null }, password: 'Secret123!' }), res);

    // email.toLowerCase() is not a function → caught by the handler's try/catch.
    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Login failed' });
  });

  it('has no lockout branch — repeated failures return the same 401 every time', async () => {
    const doc = makeUserDoc({ comparePassword: jest.fn().mockResolvedValue(false) });

    for (let attempt = 0; attempt < 10; attempt++) {
      mockLoginFindOne(doc);
      const res = makeRes();
      await login(makeReq({ email: 'user@example.com', password: 'Wrong123!' }), res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(payloadOf(res).message).toBe('Invalid username/email or password');
    }
    expect(doc.comparePassword).toHaveBeenCalledTimes(10);
  });

  it('does not record a failed attempt counter on the account', async () => {
    const doc = makeUserDoc({ comparePassword: jest.fn().mockResolvedValue(false) });
    mockLoginFindOne(doc);

    await login(makeReq({ email: 'user@example.com', password: 'Wrong123!' }), makeRes());

    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.loginAttempts).toBeUndefined();
    expect(doc.lockedUntil).toBeUndefined();
  });

  it('accepts a second concurrent login without invalidating the other device type', async () => {
    const doc = makeUserDoc({
      activeSessions: [{ jti: 'existing-mobile', deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'm' }],
    });
    mockLoginFindOne(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.activeSessions.map((s: any) => s.jti)).toContain('existing-mobile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth response data exposure
// ─────────────────────────────────────────────────────────────────────────────

describe('auth responses — sensitive field exposure locks', () => {
  const SENSITIVE = [
    'plainPassword',
    'passkey',
    'chatLockPasskey',
    'currentChallenge',
    'credentialPublicKey',
  ];

  it('login never returns password, plainPassword, passkey or WebAuthn material', async () => {
    mockLoginFindOne(makeUserDoc());
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    const user = payloadOf(res).data.user;
    expect(user.password).toBeUndefined();
    expect(user.plainPassword).toBeUndefined();
  });

  it('login does not leak the stored hash anywhere in the response body', async () => {
    const doc = makeUserDoc();
    mockLoginFindOne(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    const serialized = JSON.stringify(payloadOf(res));
    expect(serialized).not.toContain('$2a$10$storedhash');
    expect(serialized).not.toContain('reversibly-encrypted-blob');
  });

  it('login reports only a boolean passkey status, never the passkey itself', async () => {
    mockLoginFindOne(makeUserDoc());
    mockFindByIdSelect({ passkey: 'encrypted-passkey-blob' });
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(payloadOf(res).data.hasPasskey).toBe(true);
    expect(payloadOf(res).data.user.passkey).toBeUndefined();
    expect(JSON.stringify(payloadOf(res).data.user)).not.toContain('encrypted-passkey-blob');
  });

  // FINDING (new, documented not fixed): activeSessions has no select:false and
  // the model's toJSON only strips __v/password/plainPassword, so the login
  // response returns the full session list — every jti, device type and user
  // agent, including those of the user's OTHER logged-in device. The jti is the
  // value logout uses to revoke a session, so it is a session identifier
  // handed back in the response body.
  it('returns the full activeSessions list, jti values included, in the login response', async () => {
    const doc = makeUserDoc({
      activeSessions: [
        { jti: 'other-device-jti', deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'iPhone' },
      ],
    });
    mockLoginFindOne(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    const sessions = payloadOf(res).data.user.activeSessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.map((s: any) => s.jti)).toContain('other-device-jti');
    expect(sessions.find((s: any) => s.jti === 'other-device-jti').userAgent).toBe('iPhone');
  });

  // getCurrentUser serialises with toObject(), which performs no scrubbing —
  // the Batch 2 finding. This locks in that the protection is the schema's
  // select:false, so a regression that selects those fields would surface here.
  it('/auth/me leaks whatever the query returns — it performs no scrubbing of its own', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      isActive: true,
      toObject: () => ({
        _id: USER_ID,
        email: 'user@example.com',
        isActive: true,
        plainPassword: 'reversibly-encrypted-blob',
        currentChallenge: 'webauthn-challenge-value',
      }),
    });
    const res = makeRes();

    await getCurrentUser({ user: { _id: USER_ID } } as any, res);

    expect(payloadOf(res).data.plainPassword).toBe('reversibly-encrypted-blob');
    expect(payloadOf(res).data.currentChallenge).toBe('webauthn-challenge-value');
  });

  it('/auth/me returns nothing sensitive when the schema defaults apply', async () => {
    // The realistic case: select:false keeps the credential fields out.
    (User.findById as jest.Mock).mockResolvedValue({
      isActive: true,
      toObject: () => ({ _id: USER_ID, email: 'user@example.com', displayName: 'Test User', isActive: true }),
    });
    const res = makeRes();

    await getCurrentUser({ user: { _id: USER_ID } } as any, res);

    const serialized = JSON.stringify(payloadOf(res));
    for (const field of SENSITIVE) {
      expect(serialized).not.toContain(field);
    }
  });

  it('password-reset request returns no account data at all', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), res);

    expect(payloadOf(res).data).toBeUndefined();
    const serialized = JSON.stringify(payloadOf(res));
    for (const field of SENSITIVE) {
      expect(serialized).not.toContain(field);
    }
  });

  it('password reset returns no account data and no new token', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(payloadOf(res).data).toBeUndefined();
    expect(JSON.stringify(payloadOf(res))).not.toContain('eyJ');
  });

  it('an error response never carries account data', async () => {
    mockLoginFindOne(makeUserDoc({ comparePassword: jest.fn().mockResolvedValue(false) }));
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Wrong123!' }), res);

    expect(Object.keys(payloadOf(res)).sort()).toEqual(['message', 'success']);
  });
});
