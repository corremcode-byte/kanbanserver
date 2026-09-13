import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: { findOne: jest.fn(), findById: jest.fn() },
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
import { login } from '../authController';

const TEST_SECRET = 'test-jwt-secret-for-login-suite';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any, userAgent: string = DESKTOP_UA) {
  return { body, headers: { 'user-agent': userAgent } } as any;
}

/**
 * A stand-in for the Mongoose user document login() operates on: it must
 * support comparePassword, toJSON, save, and be mutated in place with
 * activeSessions / lastLoginAt.
 */
function makeUserDoc(overrides: Record<string, any> = {}) {
  const doc: any = {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    email: 'user@example.com',
    username: 'testuser',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    activeSessions: [],
    comparePassword: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  doc.toJSON = jest.fn(() => ({
    _id: '507f1f77bcf86cd799439011',
    email: doc.email,
    displayName: doc.displayName,
    role: doc.role,
  }));
  return doc;
}

/** User.findOne(...).select('+password') — chainable. */
function mockFindOneResolves(doc: any) {
  (User.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

/** User.findById(...).select('+passkey') — chainable. */
function mockFindByIdResolves(doc: any) {
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

/** Extracts the payload of the JSON body returned by successResponse. */
function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  mockFindByIdResolves({ passkey: undefined });
});

describe('login — input validation', () => {
  it('rejects incomplete credentials with 400 and never touches the database', async () => {
    const bodies = [
      { email: 'user@example.com' },
      { password: 'Secret123!' },
      {},
      { email: 'user@example.com', password: '' },
    ];

    for (const body of bodies) {
      const res = makeRes();

      await login(makeReq(body), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res)).toEqual({
        success: false,
        message: 'Username/Email and password are required',
      });
    }
    expect(User.findOne).not.toHaveBeenCalled();
  });
});

describe('login — credential checking', () => {
  it('returns 401 with a non-enumerating message when no user matches', async () => {
    mockFindOneResolves(null);
    const res = makeRes();

    await login(makeReq({ email: 'nobody@example.com', password: 'Secret123!' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res)).toEqual({
      success: false,
      message: 'Invalid username/email or password',
    });
  });

  it('returns the identical 401 message for a wrong password (no user enumeration)', async () => {
    const doc = makeUserDoc({ comparePassword: jest.fn().mockResolvedValue(false) });
    mockFindOneResolves(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'WrongPass1!' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res)).toEqual({
      success: false,
      message: 'Invalid username/email or password',
    });
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('scopes the lookup to isActive:true so a deactivated account cannot log in', async () => {
    mockFindOneResolves(null);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(User.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true })
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('normalizes the identifier to lowercase/trimmed and matches email OR username', async () => {
    mockFindOneResolves(makeUserDoc());
    await login(makeReq({ email: '  User@Example.COM  ', password: 'Secret123!' }), makeRes());

    expect(User.findOne).toHaveBeenCalledWith({
      $or: [{ email: 'user@example.com' }, { username: 'user@example.com' }],
      isActive: true,
    });
  });

  it('selects the password field explicitly (it is excluded by default)', async () => {
    const select = jest.fn().mockResolvedValue(makeUserDoc());
    (User.findOne as jest.Mock).mockReturnValue({ select });

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), makeRes());

    expect(select).toHaveBeenCalledWith('+password');
  });

  it('returns 500 without leaking internals when the database throws', async () => {
    (User.findOne as jest.Mock).mockImplementation(() => {
      throw new Error('mongo down: replica set unreachable');
    });
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Login failed' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('replica set');
  });
});

describe('login — success response and token', () => {
  it('returns 200 with the documented response shape', async () => {
    mockFindOneResolves(makeUserDoc());
    mockFindByIdResolves({ passkey: '123456' });
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = payloadOf(res);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Login successful');
    expect(Object.keys(body.data).sort()).toEqual(['deviceType', 'hasPasskey', 'token', 'user'].sort());
    expect(body.data.hasPasskey).toBe(true);
  });

  it('reports hasPasskey=false when the account has no passkey configured', async () => {
    mockFindOneResolves(makeUserDoc());
    mockFindByIdResolves({ passkey: null });
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(payloadOf(res).data.hasPasskey).toBe(false);
  });

  it('serializes the user through toJSON so the password hash never reaches the client', async () => {
    const doc = makeUserDoc();
    mockFindOneResolves(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(doc.toJSON).toHaveBeenCalled();
    expect(payloadOf(res).data.user.password).toBeUndefined();
  });

  it('issues a token carrying userId, email, role and the session jti', async () => {
    const doc = makeUserDoc({ role: 'manager' });
    mockFindOneResolves(doc);
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    const decoded = jwt.verify(payloadOf(res).data.token, TEST_SECRET) as any;
    expect(decoded.userId).toBe('507f1f77bcf86cd799439011');
    expect(decoded.email).toBe('user@example.com');
    expect(decoded.role).toBe('manager');
    expect(typeof decoded.jti).toBe('string');
    // The jti in the token must be the one persisted on the user document.
    expect(decoded.jti).toBe(doc.activeSessions[0].jti);
  });

  // SECURITY NOTE (documented, not fixed): jwt.sign is called with an empty
  // options object, so the token has iat but no exp — it is valid forever.
  // Session revocation depends entirely on the jti/activeSessions list.
  it('issues a token with no expiry claim', async () => {
    mockFindOneResolves(makeUserDoc());
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    const decoded = jwt.decode(payloadOf(res).data.token) as any;
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeUndefined();
  });

  it('records lastLoginAt and persists the document', async () => {
    const doc = makeUserDoc();
    mockFindOneResolves(doc);

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), makeRes());

    expect(doc.lastLoginAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('still succeeds when audit logging fails', async () => {
    mockFindOneResolves(makeUserDoc());
    (AuditLog.logSystemEvent as jest.Mock).mockRejectedValue(new Error('audit sink offline'));
    const res = makeRes();

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.token).toBeDefined();
  });
});

describe('login — device type and session management', () => {
  it('classifies the device from the User-Agent, defaulting to desktop when absent', async () => {
    const cases: Array<[string, string]> = [
      ['desktop', DESKTOP_UA],
      ['mobile', MOBILE_UA],
      ['desktop', ''],
    ];

    for (const [expected, ua] of cases) {
      const doc = makeUserDoc();
      mockFindOneResolves(doc);
      const res = makeRes();

      await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }, ua), res);

      expect(payloadOf(res).data.deviceType).toBe(expected);
      expect(doc.activeSessions[0].deviceType).toBe(expected);
    }
  });

  it('creates an active session entry with the jti, timestamp and user agent', async () => {
    const doc = makeUserDoc();
    mockFindOneResolves(doc);

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }, MOBILE_UA), makeRes());

    expect(doc.activeSessions).toHaveLength(1);
    expect(doc.activeSessions[0]).toMatchObject({ deviceType: 'mobile', userAgent: MOBILE_UA });
    expect(doc.activeSessions[0].loggedInAt).toBeInstanceOf(Date);
  });

  it('replaces an existing session of the SAME device type', async () => {
    const doc = makeUserDoc({
      activeSessions: [{ jti: 'old-desktop', deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'old' }],
    });
    mockFindOneResolves(doc);

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }, DESKTOP_UA), makeRes());

    expect(doc.activeSessions).toHaveLength(1);
    expect(doc.activeSessions.map((s: any) => s.jti)).not.toContain('old-desktop');
  });

  it('keeps a session of the OTHER device type — one desktop plus one mobile', async () => {
    const doc = makeUserDoc({
      activeSessions: [{ jti: 'existing-desktop', deviceType: 'desktop', loggedInAt: new Date(), userAgent: 'ua' }],
    });
    mockFindOneResolves(doc);

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }, MOBILE_UA), makeRes());

    expect(doc.activeSessions).toHaveLength(2);
    expect(doc.activeSessions.map((s: any) => s.deviceType).sort()).toEqual(['desktop', 'mobile']);
    expect(doc.activeSessions.map((s: any) => s.jti)).toContain('existing-desktop');
  });

  it('truncates an overlong User-Agent to 200 characters before storing it', async () => {
    const doc = makeUserDoc();
    mockFindOneResolves(doc);
    const longUa = 'A'.repeat(500);

    await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }, longUa), makeRes());

    expect(doc.activeSessions[0].userAgent).toHaveLength(200);
  });

  it('mints a fresh unique jti on every login', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const doc = makeUserDoc();
      mockFindOneResolves(doc);
      const res = makeRes();
      await login(makeReq({ email: 'user@example.com', password: 'Secret123!' }), res);
      seen.add((jwt.decode(payloadOf(res).data.token) as any).jti);
    }
    expect(seen.size).toBe(3);
  });
});
