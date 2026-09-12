import jwt from 'jsonwebtoken';

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

import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { emailService } from '../../services/emailService';
import { validatePassword } from '../../utils/validation';
import { requestPasswordReset, resetPassword } from '../authController';

const TEST_SECRET = 'test-jwt-secret-for-password-reset-suite';
const USER_ID = '507f1f77bcf86cd799439011';

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

function makeReq(body: any) {
  return { body, headers: {} } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeUserDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    displayName: 'Test User',
    password: '$2a$10$existinghashvalue0000000000000000000000000000000000000',
    isActive: true,
    activeSessions: [
      { jti: 'desktop-session', deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'ua' },
      { jti: 'mobile-session', deviceType: 'mobile', loggedInAt: new Date(), userAgent: 'ua' },
    ] as any[],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Mints a genuine reset token exactly as requestPasswordReset does. */
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
});

// ─────────────────────────────────────────────────────────────────────────────
// requestPasswordReset  (POST /auth/forgot-password)
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_MESSAGE = 'If this email exists in our system, a password reset link has been sent';

describe('requestPasswordReset — input validation', () => {
  it('requires an email address', async () => {
    const res = makeRes();

    await requestPasswordReset(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Email is required' });
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('rejects a non-string email rather than passing it into the query', async () => {
    const res = makeRes();

    // An object here would otherwise reach the Mongo query as an operator.
    await requestPasswordReset(makeReq({ email: { $ne: null } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Email is required' });
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('normalizes the email to lowercase and trims it, scoped to active accounts', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);

    await requestPasswordReset(makeReq({ email: '  User@Example.COM  ' }), makeRes());

    expect(User.findOne).toHaveBeenCalledWith({ email: 'user@example.com', isActive: true });
  });
});

describe('requestPasswordReset — account enumeration resistance', () => {
  it('returns the generic success message for an unregistered email', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'nobody@example.com' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe(GENERIC_MESSAGE);
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('treats a deactivated account exactly like a missing one', async () => {
    // The isActive:true filter means a deactivated user simply does not match.
    (User.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'deactivated@example.com' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe(GENERIC_MESSAGE);
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns a byte-identical response for a registered and an unregistered email', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    const existing = makeRes();
    await requestPasswordReset(makeReq({ email: 'user@example.com' }), existing);

    (User.findOne as jest.Mock).mockResolvedValue(null);
    const missing = makeRes();
    await requestPasswordReset(makeReq({ email: 'nobody@example.com' }), missing);

    expect(payloadOf(existing)).toEqual(payloadOf(missing));
    expect(existing.status.mock.calls).toEqual(missing.status.mock.calls);
  });

  it('accepts a syntactically malformed address without revealing that it is invalid', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'not-an-email' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe(GENERIC_MESSAGE);
  });
});

describe('requestPasswordReset — token issuance', () => {
  it('emails a reset link containing a token scoped to the requesting user', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), makeRes());

    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [recipient, params] = (emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0];
    expect(recipient).toBe('user@example.com');
    expect(params.resetLink.startsWith('https://app.test.example/reset-password?token=')).toBe(true);
    expect(params.expiresInMinutes).toBe(60);
    expect(params.userName).toBe('Test User');
  });

  it('mints a token typed password-reset and bound to the user id and email', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), makeRes());

    const { resetLink } = (emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0][1];
    const token = new URL(resetLink).searchParams.get('token')!;
    const decoded = jwt.verify(token, TEST_SECRET) as any;

    expect(decoded.type).toBe('password-reset');
    expect(decoded.userId).toBe(USER_ID);
    expect(decoded.email).toBe('user@example.com');
  });

  it('gives the reset token a one-hour expiry', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), makeRes());

    const { resetLink } = (emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0][1];
    const decoded = jwt.decode(new URL(resetLink).searchParams.get('token')!) as any;

    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it('never returns the reset token in the HTTP response body', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), res);

    const serialized = JSON.stringify(payloadOf(res));
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('eyJ'); // the JWT header prefix
    expect(payloadOf(res).data).toBeUndefined();
  });

  it('falls back to the email address as the greeting name when displayName is unset', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ displayName: undefined }));

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), makeRes());

    const params = (emailService.sendPasswordResetEmail as jest.Mock).mock.calls[0][1];
    expect(params.userName).toBe('user@example.com');
  });
});

describe('requestPasswordReset — failure handling', () => {
  it('still returns the generic success message when sending the email throws', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    (emailService.sendPasswordResetEmail as jest.Mock).mockRejectedValue(new Error('SMTP refused'));
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe(GENERIC_MESSAGE);
  });

  it('still returns the generic success message when the mailer reports failure', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    (emailService.sendPasswordResetEmail as jest.Mock).mockResolvedValue(false);
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe(GENERIC_MESSAGE);
  });

  it('returns 500 when the user lookup throws', async () => {
    (User.findOne as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await requestPasswordReset(makeReq({ email: 'user@example.com' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({
      success: false,
      message: 'Failed to process password reset request',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resetPassword  (POST /auth/reset-password)
// ─────────────────────────────────────────────────────────────────────────────

describe('resetPassword — input validation', () => {
  it('rejects a request missing the token, the new password, or both', async () => {
    const bodies = [{ newPassword: 'N3w!StrongPass' }, { token: 'something' }, {}];

    for (const body of bodies) {
      const res = makeRes();

      await resetPassword(makeReq(body), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res)).toEqual({
        success: false,
        message: 'Token and new password are required',
      });
    }
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than six characters before verifying the token', async () => {
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'Ab1!' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({
      success: false,
      message: 'Password must be at least 6 characters long',
    });
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('resetPassword — token validation', () => {
  it('rejects a structurally malformed token', async () => {
    const res = makeRes();

    await resetPassword(makeReq({ token: 'not-a-jwt', newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Invalid or expired reset token' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ userId: USER_ID, type: 'password-reset' }, 'attacker-secret');
    const res = makeRes();

    await resetPassword(makeReq({ token: forged, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Invalid or expired reset token' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects an expired reset token', async () => {
    const expired = makeResetToken({}, { expiresIn: '-1m' });
    const res = makeRes();

    await resetPassword(makeReq({ token: expired, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Invalid or expired reset token' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a validly-signed login token — a session token is not a reset token', async () => {
    // Exactly the payload shape login() issues: no `type` claim at all.
    const loginToken = jwt.sign(
      { userId: USER_ID, email: 'user@example.com', role: 'member', jti: 'session-1' },
      TEST_SECRET
    );
    const res = makeRes();

    await resetPassword(makeReq({ token: loginToken, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Invalid reset token' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token carrying some other type claim', async () => {
    const wrongType = makeResetToken({ type: 'email-verification' });
    const res = makeRes();

    await resetPassword(makeReq({ token: wrongType, newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Invalid reset token' });
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('resetPassword — target account state', () => {
  it('returns 404 when the token references a deleted user', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('refuses to reset the password of a deactivated account', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc({ isActive: false }));
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res)).toEqual({ success: false, message: 'User not found' });
  });

  it('resolves the target strictly from the token, ignoring any caller-supplied id', async () => {
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);

    await resetPassword(
      makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass', userId: 'attacker-chosen-id' }),
      makeRes()
    );

    expect(User.findById).toHaveBeenCalledWith(USER_ID);
    expect(User.findById).not.toHaveBeenCalledWith('attacker-chosen-id');
  });
});

describe('resetPassword — successful reset', () => {
  it('assigns the new password and persists, leaving hashing to the pre-save hook', async () => {
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(doc.password).toBe('N3w!StrongPass');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe('Password has been reset successfully');
  });

  it('replaces the previously stored hash rather than appending to it', async () => {
    const doc = makeUserDoc();
    const originalHash = doc.password;
    (User.findById as jest.Mock).mockResolvedValue(doc);

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), makeRes());

    expect(doc.password).not.toBe(originalHash);
  });

  it('returns no user payload and leaks no password material', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    const serialized = JSON.stringify(payloadOf(res));
    expect(payloadOf(res).data).toBeUndefined();
    expect(serialized).not.toContain('N3w!StrongPass');
    expect(serialized).not.toContain('plainPassword');
  });

  it('writes a user_password_reset audit entry carrying no password material', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), makeRes());

    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'user_password_reset',
        metadata: expect.objectContaining({ resetMethod: 'token' }),
      })
    );
    const entry = (AuditLog.logSystemEvent as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain('N3w!StrongPass');
  });

  it('still reports success when audit logging fails', async () => {
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);
    (AuditLog.logSystemEvent as jest.Mock).mockRejectedValue(new Error('audit sink offline'));
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 without leaking internals when the save fails', async () => {
    (User.findById as jest.Mock).mockResolvedValue(
      makeUserDoc({ save: jest.fn().mockRejectedValue(new Error('write concern failed on replica-2')) })
    );
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to reset password' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('replica-2');
  });
});

describe('resetPassword — security findings (documented, not fixed)', () => {
  // FINDING: resetPassword enforces only `newPassword.length < 6`. It never
  // calls validatePassword(), so the reset path accepts passwords the
  // authenticated change path (updatePassword) rejects outright — a complete
  // bypass of the complexity policy, the common-password blocklist and the
  // 64-character maximum.
  it('accepts weak passwords that the authenticated change path rejects', async () => {
    const weakButAccepted = ['abc123', 'password', 'aaaaaa', '123456'];

    for (const weak of weakButAccepted) {
      // Every one of these fails the real policy used by updatePassword …
      expect(validatePassword(weak).valid).toBe(false);

      const doc = makeUserDoc();
      (User.findById as jest.Mock).mockResolvedValue(doc);
      const res = makeRes();

      // … yet the reset endpoint stores it.
      await resetPassword(makeReq({ token: makeResetToken(), newPassword: weak }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(doc.password).toBe(weak);
      expect(doc.save).toHaveBeenCalledTimes(1);
    }
  });

  it('accepts a six-character password, four short of the documented minimum', async () => {
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'Abc12!' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(validatePassword('Abc12!').errors).toContain('At least 8 characters required');
  });

  it('accepts a password above the 64-character maximum enforced elsewhere', async () => {
    const doc = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const overlong = `Abc123!${'a'.repeat(200)}`;
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: overlong }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(validatePassword(overlong).errors).toContain('Maximum 64 characters allowed');
  });

  // FINDING: the reset token is a stateless JWT with no nonce, no
  // single-use marker and no invalidation on use. It stays valid for its full
  // hour, so anyone who obtains it (mail archive, proxy log, shared inbox) can
  // replay it repeatedly — including after the legitimate user has reset.
  it('allows the same reset token to be replayed after a successful reset', async () => {
    const token = makeResetToken();

    const first = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(first);
    const firstRes = makeRes();
    await resetPassword(makeReq({ token, newPassword: 'First!Pass1' }), firstRes);
    expect(firstRes.status).toHaveBeenCalledWith(200);

    // Same token, second use — an attacker overwriting the victim's new password.
    const second = makeUserDoc();
    (User.findById as jest.Mock).mockResolvedValue(second);
    const secondRes = makeRes();
    await resetPassword(makeReq({ token, newPassword: 'Second!Pass1' }), secondRes);

    expect(secondRes.status).toHaveBeenCalledWith(200);
    expect(second.password).toBe('Second!Pass1');
  });

  // FINDING: resetting the password does not clear activeSessions, so a
  // password reset performed precisely because the account was compromised
  // leaves the attacker's existing sessions working.
  it('leaves every pre-existing session active after a password reset', async () => {
    const doc = makeUserDoc();
    const before = doc.activeSessions.map((s: any) => s.jti);
    (User.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await resetPassword(makeReq({ token: makeResetToken(), newPassword: 'N3w!StrongPass' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.activeSessions.map((s: any) => s.jti)).toEqual(before);
  });
});
