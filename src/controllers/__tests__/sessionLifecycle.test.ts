/**
 * Cross-component session lifecycle: a token is minted by the real login
 * controller, then handed to the real authenticate middleware after some state
 * change (logout, deactivation, deletion, password change/reset). Batch 1
 * covered each component in isolation; this suite covers the handoff between
 * them, which is where session-invalidation gaps actually surface.
 */

jest.mock('../../models', () => ({
  User: { findOne: jest.fn(), findById: jest.fn(), findByIdAndUpdate: jest.fn() },
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

jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  genSalt: jest.fn(),
  hash: jest.fn(),
}));

import bcrypt from 'bcryptjs';
import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { login, updatePassword, resetPassword, deactivateAccount } from '../authController';
import { authenticate } from '../../middleware/auth';

const TEST_SECRET = 'test-jwt-secret-for-session-lifecycle';
const USER_ID = '507f1f77bcf86cd799439011';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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

/** A persistent account record shared between the login and authenticate legs. */
function makeAccount(overrides: Record<string, any> = {}): Record<string, any> {
  const account: any = {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    username: 'testuser',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    password: '$2a$10$storedhashvalue000000000000000000000000000000000000000',
    activeSessions: [] as any[],
    comparePassword: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  account.toJSON = jest.fn(() => ({ _id: USER_ID, email: account.email, role: account.role }));
  return account;
}

/** Runs the real login controller against `account`, returning the issued token. */
async function loginAs(account: any, userAgent: string = DESKTOP_UA): Promise<string> {
  (User.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(account) });
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue({ passkey: null }) });
  const res = makeRes();
  await login(
    { body: { email: account.email, password: 'Correct!Pass1' }, headers: { 'user-agent': userAgent } } as any,
    res
  );
  expect(res.status).toHaveBeenCalledWith(200);
  return payloadOf(res).data.token;
}

/** Runs the real authenticate middleware with `token` against `account`. */
async function authenticateWith(token: string, account: any) {
  (User.findById as jest.Mock).mockReset();
  (User.findById as jest.Mock).mockResolvedValue(account);
  const req: any = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res = makeRes();
  const next = jest.fn();
  await authenticate(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
});

describe('session lifecycle — establishment', () => {
  it('a token minted by login is accepted by authenticate against the same account', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    const { res, next, req } = await authenticateWith(token, account);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user._id).toBe(USER_ID);
  });

  it('a second login from the same device type invalidates the first device token', async () => {
    const account = makeAccount();
    const firstToken = await loginAs(account, DESKTOP_UA);
    const secondToken = await loginAs(account, DESKTOP_UA);

    const stale = await authenticateWith(firstToken, account);
    expect(stale.next).not.toHaveBeenCalled();
    expect(stale.res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(stale.res).message).toBe('Session expired or logged in from another device');

    const fresh = await authenticateWith(secondToken, account);
    expect(fresh.next).toHaveBeenCalledTimes(1);
  });

  it('a mobile login leaves an existing desktop token working, and both stay valid', async () => {
    const account = makeAccount();
    const desktopToken = await loginAs(account, DESKTOP_UA);
    const mobileToken = await loginAs(account, MOBILE_UA);

    expect(account.activeSessions).toHaveLength(2);

    const desktop = await authenticateWith(desktopToken, account);
    const mobile = await authenticateWith(mobileToken, account);

    expect(desktop.next).toHaveBeenCalledTimes(1);
    expect(mobile.next).toHaveBeenCalledTimes(1);
  });
});

describe('session lifecycle — revocation', () => {
  it('removing the jti from activeSessions (as logout does) stops the token working', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    // Exactly what the logout route's $pull achieves.
    account.activeSessions = [];

    const { res, next } = await authenticateWith(token, account);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Session expired or logged in from another device');
  });

  it('a token stops working once the account is deactivated', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue({ ...account, isActive: false });
    await deactivateAccount({ body: {}, user: { _id: USER_ID } } as any, makeRes());

    // authenticate re-reads the stored account, which is now inactive.
    const { res, next } = await authenticateWith(token, { ...account, isActive: false });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Account is deactivated');
  });

  it('a token stops working once the account record is gone', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    const { res, next } = await authenticateWith(token, null);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('User not found');
  });

  it('a deactivated account still holds its stale session entry, which revives on reactivation', async () => {
    const account = makeAccount();
    const token = await loginAs(account);
    const jtiBefore = account.activeSessions[0].jti;

    (User.findByIdAndUpdate as jest.Mock).mockResolvedValue({ ...account, isActive: false });
    await deactivateAccount({ body: {}, user: { _id: USER_ID } } as any, makeRes());

    // Deactivation cleared nothing, so flipping isActive back restores access
    // with the *same* pre-deactivation token.
    expect(account.activeSessions[0].jti).toBe(jtiBefore);
    const revived = await authenticateWith(token, { ...account, isActive: true });
    expect(revived.next).toHaveBeenCalledTimes(1);
  });
});

describe('session lifecycle — credential changes', () => {
  // FINDING (documented, not fixed): a password change does not revoke
  // sessions, so a token issued before the change keeps working afterwards.
  it('a token issued before a password change still authenticates after it', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    (User.findById as jest.Mock).mockReset();
    (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(account) });
    const changeRes = makeRes();
    await updatePassword(
      { body: { currentPassword: 'Correct!Pass1', newPassword: 'N3w!StrongPass' }, user: { _id: USER_ID } } as any,
      changeRes
    );
    expect(changeRes.status).toHaveBeenCalledWith(200);

    const { res, next } = await authenticateWith(token, account);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // FINDING (documented, not fixed): the same holds for a password reset, which
  // is the flow a user runs precisely when they believe they are compromised.
  it('a token issued before a password reset still authenticates after it', async () => {
    const account = makeAccount();
    const token = await loginAs(account);

    const jwt = require('jsonwebtoken');
    const resetToken = jwt.sign(
      { userId: USER_ID, email: account.email, type: 'password-reset' },
      TEST_SECRET,
      { expiresIn: '1h' }
    );
    (User.findById as jest.Mock).mockReset();
    (User.findById as jest.Mock).mockResolvedValue(account);
    const resetRes = makeRes();
    await resetPassword({ body: { token: resetToken, newPassword: 'N3w!StrongPass' }, headers: {} } as any, resetRes);
    expect(resetRes.status).toHaveBeenCalledWith(200);

    const { res, next } = await authenticateWith(token, account);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('a password change leaves the other device session intact as well', async () => {
    const account = makeAccount();
    const desktopToken = await loginAs(account, DESKTOP_UA);
    const mobileToken = await loginAs(account, MOBILE_UA);

    (User.findById as jest.Mock).mockReset();
    (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(account) });
    await updatePassword(
      { body: { currentPassword: 'Correct!Pass1', newPassword: 'N3w!StrongPass' }, user: { _id: USER_ID } } as any,
      makeRes()
    );

    expect(account.activeSessions).toHaveLength(2);
    expect((await authenticateWith(desktopToken, account)).next).toHaveBeenCalledTimes(1);
    expect((await authenticateWith(mobileToken, account)).next).toHaveBeenCalledTimes(1);
  });
});
