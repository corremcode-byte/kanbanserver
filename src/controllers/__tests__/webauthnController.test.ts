/**
 * WebAuthn / biometric authentication.
 *
 * The @simplewebauthn/server library is mocked so verification outcomes are
 * driven by the test rather than by real cryptography — no new infrastructure.
 *
 * NOTE (finding, documented not fixed): webauthnController is not mounted on
 * any router. Nothing under src/routes imports it, so these handlers are
 * currently unreachable dead code. The behaviours below are what would apply if
 * it were wired up; the wiring gap itself is asserted in
 * src/routes/__tests__/authRouteWiring.test.ts.
 */

import jwt from 'jsonwebtoken';

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

jest.mock('../../models/User', () => {
  const User: any = { findById: jest.fn(), findOne: jest.fn(), findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn() };
  return { __esModule: true, default: User, User };
});

jest.mock('../../models/AuditLog', () => {
  const AuditLog: any = { logSystemEvent: jest.fn(), logAction: jest.fn() };
  return { __esModule: true, default: AuditLog, AuditLog };
});

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import User from '../../models/User';
import AuditLog from '../../models/AuditLog';
import {
  getRegisterOptions,
  verifyRegistration,
  getAuthOptions,
  verifyAuthentication,
  getBiometricStatus,
} from '../webauthnController';

const TEST_SECRET = 'test-jwt-secret-for-webauthn';
const USER_ID = '507f1f77bcf86cd799439011';
const CRED_ID = 'credential-abc-123';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.WEBAUTHN_RP_ID = 'test.example';
  process.env.WEBAUTHN_ORIGIN = 'https://test.example';
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_ID },
    body: {},
    headers: { origin: 'https://test.example', host: 'test.example' },
    hostname: 'test.example',
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeCredential(overrides: Record<string, any> = {}) {
  return {
    credentialID: CRED_ID,
    credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
    counter: 5,
    transports: ['internal'],
    ...overrides,
  };
}

function makeUserDoc(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    currentChallenge: 'stored-challenge',
    webauthnCredentials: [makeCredential()],
    activeSessions: [] as any[],
    ...overrides,
  };
}

/** User.findById(...).select('+currentChallenge') — chainable. */
function mockFindByIdSelect(doc: any) {
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

/** User.findOne(...).select('+currentChallenge') — chainable. */
function mockFindOneSelect(doc: any) {
  (User.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

beforeEach(() => {
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
  (User.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
  (User.findOneAndUpdate as jest.Mock).mockResolvedValue({});
  (generateRegistrationOptions as jest.Mock).mockResolvedValue({ challenge: 'new-reg-challenge' });
  (generateAuthenticationOptions as jest.Mock).mockResolvedValue({ challenge: 'new-auth-challenge' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration challenge
// ─────────────────────────────────────────────────────────────────────────────

describe('getRegisterOptions — challenge creation (authenticated)', () => {
  it('returns 404 when the authenticated user no longer exists', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getRegisterOptions(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('generates options bound to the user and persists the challenge', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await getRegisterOptions(makeReq(), res);

    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'user@example.com', userDisplayName: 'Test User' })
    );
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
      currentChallenge: 'new-reg-challenge',
    });
    expect(payloadOf(res)).toEqual({ success: true, data: { challenge: 'new-reg-challenge' } });
  });

  it('requires user verification and excludes already-registered credentials', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());

    await getRegisterOptions(makeReq(), makeRes());

    const opts = (generateRegistrationOptions as jest.Mock).mock.calls[0][0];
    expect(opts.authenticatorSelection.userVerification).toBe('required');
    expect(opts.excludeCredentials).toEqual([{ id: CRED_ID, transports: ['internal'] }]);
  });

  it('sends an empty exclude list when the user has no credentials yet', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc({ webauthnCredentials: undefined }));

    await getRegisterOptions(makeReq(), makeRes());

    expect((generateRegistrationOptions as jest.Mock).mock.calls[0][0].excludeCredentials).toEqual([]);
  });

  it('returns 500 when option generation throws', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    (generateRegistrationOptions as jest.Mock).mockRejectedValue(new Error('rp misconfigured'));
    const res = makeRes();

    await getRegisterOptions(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Failed to generate registration options');
  });
});

describe('verifyRegistration', () => {
  it('rejects when there is no pending challenge stored', async () => {
    mockFindByIdSelect(makeUserDoc({ currentChallenge: undefined }));
    const res = makeRes();

    await verifyRegistration(makeReq({ body: { id: CRED_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('No pending registration challenge');
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects when the user record is gone', async () => {
    mockFindByIdSelect(null);
    const res = makeRes();

    await verifyRegistration(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('No pending registration challenge');
  });

  it('verifies against the stored challenge, origin and RP id', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred', publicKey: Buffer.from('pk'), counter: 0 } },
    });

    await verifyRegistration(makeReq({ body: { id: 'new-cred' } }), makeRes());

    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'stored-challenge',
        expectedOrigin: 'https://test.example',
        expectedRPID: 'test.example',
      })
    );
  });

  it('rejects a failed verification without storing a credential', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({ verified: false });
    const res = makeRes();

    await verifyRegistration(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Biometric registration failed');
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a verification that reports verified but carries no registrationInfo', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({ verified: true });
    const res = makeRes();

    await verifyRegistration(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('stores the credential and clears the challenge on success', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred', publicKey: Buffer.from('pk-bytes'), counter: 3 } },
    });
    const res = makeRes();

    await verifyRegistration(
      makeReq({ body: { id: 'new-cred', response: { transports: ['internal'] } } }),
      res
    );

    const update = (User.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(update.$push.webauthnCredentials).toMatchObject({ credentialID: 'new-cred', counter: 3 });
    expect(update.$push.webauthnCredentials.credentialPublicKey).toBe(
      Buffer.from('pk-bytes').toString('base64')
    );
    expect(update.$unset).toEqual({ currentChallenge: 1 });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('audits a successful registration', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred', publicKey: Buffer.from('pk'), counter: 0 } },
    });

    await verifyRegistration(makeReq({ body: {} }), makeRes());

    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, action: 'biometric_registered' })
    );
  });

  it('still succeeds when audit logging fails', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'new-cred', publicKey: Buffer.from('pk'), counter: 0 } },
    });
    (AuditLog.logSystemEvent as jest.Mock).mockRejectedValue(new Error('audit offline'));
    const res = makeRes();

    await verifyRegistration(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('surfaces a library verification error as a 400', async () => {
    mockFindByIdSelect(makeUserDoc());
    (verifyRegistrationResponse as jest.Mock).mockRejectedValue(new Error('challenge mismatch'));
    const res = makeRes();

    await verifyRegistration(makeReq({ body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('challenge mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication challenge (unauthenticated endpoints)
// ─────────────────────────────────────────────────────────────────────────────

describe('getAuthOptions — unauthenticated challenge creation', () => {
  it('requires an email', async () => {
    const res = makeRes();

    await getAuthOptions(makeReq({ user: undefined, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Email is required');
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('looks the account up by email or username, lowercased', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);

    await getAuthOptions(makeReq({ user: undefined, body: { email: 'User@Example.COM' } }), makeRes());

    expect(User.findOne).toHaveBeenCalledWith({
      $or: [{ email: 'user@example.com' }, { username: 'user@example.com' }],
    });
  });

  it('refuses a deactivated account with 403', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ isActive: false }));
    const res = makeRes();

    await getAuthOptions(makeReq({ user: undefined, body: { email: 'user@example.com' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Account is deactivated');
    expect(generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('reports when an account has no registered credentials', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ webauthnCredentials: [] }));
    const res = makeRes();

    await getAuthOptions(makeReq({ user: undefined, body: { email: 'user@example.com' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('No biometric credentials registered');
  });

  it('generates options restricted to that account’s credentials and stores the challenge', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await getAuthOptions(makeReq({ user: undefined, body: { email: 'user@example.com' } }), res);

    const opts = (generateAuthenticationOptions as jest.Mock).mock.calls[0][0];
    expect(opts.allowCredentials).toEqual([{ id: CRED_ID, transports: ['internal'] }]);
    expect(opts.userVerification).toBe('required');
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { currentChallenge: 'new-auth-challenge' }
    );
    expect(payloadOf(res)).toEqual({ success: true, data: { challenge: 'new-auth-challenge' } });
  });

  // SECURITY FINDING (new, documented not fixed): this unauthenticated endpoint
  // returns three distinct outcomes for an unknown account, a deactivated
  // account and an account with no credentials. That is account enumeration —
  // and it is the opposite of the deliberate non-enumerating behaviour of
  // login() and requestPasswordReset(), which both return a generic response.
  it('distinguishes unknown, deactivated and credential-less accounts to an anonymous caller', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);
    const unknown = makeRes();
    await getAuthOptions(makeReq({ user: undefined, body: { email: 'nobody@example.com' } }), unknown);

    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ isActive: false }));
    const deactivated = makeRes();
    await getAuthOptions(makeReq({ user: undefined, body: { email: 'user@example.com' } }), deactivated);

    (User.findOne as jest.Mock).mockResolvedValue(makeUserDoc({ webauthnCredentials: [] }));
    const noCreds = makeRes();
    await getAuthOptions(makeReq({ user: undefined, body: { email: 'user@example.com' } }), noCreds);

    expect(payloadOf(unknown).message).toBe('User not found');
    expect(payloadOf(deactivated).message).toBe('Account is deactivated');
    expect(payloadOf(noCreds).message).toBe('No biometric credentials registered');
    // All three differ — an anonymous caller learns which accounts exist.
    const messages = [unknown, deactivated, noCreds].map((r) => payloadOf(r).message);
    expect(new Set(messages).size).toBe(3);
  });
});

describe('verifyAuthentication', () => {
  it('requires both email and response', async () => {
    for (const body of [{}, { email: 'user@example.com' }, { response: { id: CRED_ID } }]) {
      const res = makeRes();
      await verifyAuthentication(makeReq({ user: undefined, body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Email and response are required');
    }
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('rejects when no challenge is pending for the account', async () => {
    mockFindOneSelect(makeUserDoc({ currentChallenge: undefined }));
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('No pending authentication challenge');
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('rejects an unknown account with the same challenge message', async () => {
    mockFindOneSelect(null);
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'nobody@example.com', response: { id: CRED_ID } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('No pending authentication challenge');
  });

  it('refuses a deactivated account', async () => {
    mockFindOneSelect(makeUserDoc({ isActive: false }));
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('rejects a credential id that the account does not own', async () => {
    // Actor presents a credential belonging to a different account.
    mockFindOneSelect(makeUserDoc());
    const res = makeRes();

    await verifyAuthentication(
      makeReq({
        user: undefined,
        body: { email: 'user@example.com', response: { id: 'someone-elses-credential' } },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Credential not found');
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('verifies against the stored challenge and the stored credential material', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      makeRes()
    );

    const args = (verifyAuthenticationResponse as jest.Mock).mock.calls[0][0];
    expect(args.expectedChallenge).toBe('stored-challenge');
    expect(args.expectedRPID).toBe('test.example');
    expect(args.credential.id).toBe(CRED_ID);
    expect(args.credential.counter).toBe(5);
  });

  it('rejects a failed verification with 401 and issues no token', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({ verified: false });
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Biometric authentication failed');
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('advances the signature counter and clears the challenge on success', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 9 },
    });

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      makeRes()
    );

    const [filter, update] = (User.findOneAndUpdate as jest.Mock).mock.calls[0];
    expect(filter['webauthnCredentials.credentialID']).toBe(CRED_ID);
    expect(update.$set['webauthnCredentials.$.counter']).toBe(9);
    expect(update.$unset).toEqual({ currentChallenge: 1 });
    expect(update.lastLoginAt).toBeInstanceOf(Date);
  });

  it('issues a signed token and a minimal user payload on success', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    const data = payloadOf(res).data;
    const decoded = jwt.verify(data.token, TEST_SECRET) as any;
    expect(decoded.userId).toBe(USER_ID);
    expect(decoded.role).toBe('member');
    expect(Object.keys(data.user).sort()).toEqual(['displayName', 'email', 'id', 'role']);
  });

  it('never returns credential material or the challenge in the response', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    const serialized = JSON.stringify(payloadOf(res));
    expect(serialized).not.toContain('stored-challenge');
    expect(serialized).not.toContain('credentialPublicKey');
    expect(serialized).not.toContain(Buffer.from('public-key-bytes').toString('base64'));
  });

  // SECURITY FINDING (new, documented not fixed): the biometric login path
  // issues a token with NO jti and never calls upsertActiveSession, so the
  // session is never registered in user.activeSessions. Combined with the
  // Batch 1 finding that authenticate() skips session validation when the jti
  // is absent, such a token cannot be revoked by logout or device eviction —
  // it stays valid for its full 7-day life.
  it('issues a jti-less token and registers no active session', async () => {
    const userDoc = makeUserDoc({ activeSessions: [] });
    mockFindOneSelect(userDoc);
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    const decoded = jwt.decode(payloadOf(res).data.token) as any;
    expect(decoded.jti).toBeUndefined();

    // Nothing was written to activeSessions by this login.
    const update = (User.findOneAndUpdate as jest.Mock).mock.calls[0][1];
    expect(JSON.stringify(update)).not.toContain('activeSessions');
    expect(userDoc.activeSessions).toEqual([]);
  });

  it('gives the biometric token a 7-day expiry, unlike the password-login token', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    const decoded = jwt.decode(payloadOf(res).data.token) as any;
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
  });

  it('audits a successful biometric login', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      makeRes()
    );

    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_login', metadata: { method: 'biometric' } })
    );
  });

  it('surfaces a library error as a 400 without issuing a token', async () => {
    mockFindOneSelect(makeUserDoc());
    (verifyAuthenticationResponse as jest.Mock).mockRejectedValue(new Error('origin mismatch'));
    const res = makeRes();

    await verifyAuthentication(
      makeReq({ user: undefined, body: { email: 'user@example.com', response: { id: CRED_ID } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('origin mismatch');
    expect(payloadOf(res).data).toBeUndefined();
  });
});

describe('getBiometricStatus', () => {
  it('returns 404 when the authenticated user is gone', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getBiometricStatus(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('reports only whether credentials exist, never the credentials themselves', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc());
    const res = makeRes();

    await getBiometricStatus(makeReq(), res);

    expect(payloadOf(res).data).toEqual({ hasCredentials: true });
    expect(JSON.stringify(payloadOf(res))).not.toContain('credentialPublicKey');
    expect(JSON.stringify(payloadOf(res))).not.toContain(CRED_ID);
  });

  it('reports false for an account with an empty credential list', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUserDoc({ webauthnCredentials: [] }));
    const res = makeRes();

    await getBiometricStatus(makeReq(), res);

    expect(payloadOf(res).data).toEqual({ hasCredentials: false });
  });
});
