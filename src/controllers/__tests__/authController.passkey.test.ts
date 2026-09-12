/**
 * Application-level passkey (6-digit PIN) — set, verify, change and status.
 * This is a separate mechanism from WebAuthn/biometrics (webauthnController).
 *
 * Includes the duress-passkey path, which is an intentional product feature;
 * the tests document exactly what it does rather than judging it.
 */

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

import jwt from 'jsonwebtoken';
import { User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { decrypt } from '../../utils/encryption';
import {
  setPasskey,
  verifyPasskey,
  changePasskey,
  checkPasskeyStatus,
} from '../authController';

const TEST_SECRET = 'test-jwt-secret-for-passkey-suite';
const USER_ID = '507f1f77bcf86cd799439011';
const DUMMY_ID = '507f1f77bcf86cd799439099';
const VALID_PASSKEY = '481902';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

beforeEach(() => {
  delete process.env.DUMMY_PASSKEY;
  delete process.env.DUMMY_USER_EMAIL;
  (AuditLog.logSystemEvent as jest.Mock).mockResolvedValue(undefined);
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any = {}, user: any = { _id: USER_ID }) {
  return { body, user, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' } } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeUserDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: { toString: () => USER_ID },
    email: 'user@example.com',
    displayName: 'Test User',
    role: 'member',
    isActive: true,
    passkey: undefined as any,
    activeSessions: [] as any[],
    comparePasskey: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** User.findById(...).select('+passkey') — chainable. */
function mockFindByIdSelect(doc: any) {
  (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });
}

describe('setPasskey', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('requires a passkey value of string type', async () => {
    for (const passkey of [undefined, '', 481902, null]) {
      const res = makeRes();
      await setPasskey(makeReq({ passkey }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Passkey is required');
    }
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('enforces every passkey pattern rule before touching the database', async () => {
    const cases: Array<[string, string]> = [
      ['12345', 'Must be exactly 6 digits (0–9 only)'],
      ['1234567', 'Must be exactly 6 digits (0–9 only)'],
      ['12a456', 'Must be exactly 6 digits (0–9 only)'],
      ['111111', 'Cannot be all identical digits (e.g. 000000, 111111)'],
      ['123456', 'Cannot be a sequential pattern (e.g. 123456, 654321)'],
      ['654321', 'Cannot be a sequential pattern (e.g. 123456, 654321)'],
      ['121212', 'Cannot be a repeating pattern (e.g. 121212, 010101)'],
      ['481481', 'Cannot be a repeating pattern (e.g. 123123)'],
      ['112233', 'Cannot be a repeating-pairs pattern (e.g. 112233, 445566)'],
    ];

    for (const [passkey, expectedMessage] of cases) {
      const res = makeRes();
      await setPasskey(makeReq({ passkey }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe(expectedMessage);
    }
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('returns 404 when the authenticated user no longer exists', async () => {
    mockFindByIdSelect(null);
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('refuses to overwrite an existing passkey', async () => {
    const doc = makeUserDoc({ passkey: 'already-encrypted' });
    mockFindByIdSelect(doc);
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Passkey already set. Use change passkey to update it.');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('stores the passkey encrypted rather than in plaintext', async () => {
    const doc = makeUserDoc();
    mockFindByIdSelect(doc);
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(doc.passkey).not.toBe(VALID_PASSKEY);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // The passkey is stored under reversible encryption, not a one-way hash —
  // the same pattern as the plainPassword finding from Batch 2.
  it('stores the passkey reversibly — it can be decrypted back to the PIN', async () => {
    const doc = makeUserDoc();
    mockFindByIdSelect(doc);

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), makeRes());

    expect(decrypt(doc.passkey)).toBe(VALID_PASSKEY);
  });

  it('never echoes the passkey back to the client', async () => {
    mockFindByIdSelect(makeUserDoc());
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(JSON.stringify(payloadOf(res))).not.toContain(VALID_PASSKEY);
    expect(payloadOf(res).data).toBeUndefined();
  });

  it('audits the passkey setup without recording the value', async () => {
    mockFindByIdSelect(makeUserDoc());

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), makeRes());

    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, action: 'user_passkey_set' })
    );
    const entry = (AuditLog.logSystemEvent as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain(VALID_PASSKEY);
  });

  it('returns 500 when the save fails', async () => {
    mockFindByIdSelect(makeUserDoc({ save: jest.fn().mockRejectedValue(new Error('write failed')) }));
    const res = makeRes();

    await setPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Failed to set passkey');
  });
});

describe('verifyPasskey', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('requires a string passkey', async () => {
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: 481902 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Passkey is required');
  });

  it('returns 400 when the account has no passkey configured', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: undefined }));
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Passkey not set');
  });

  it('rejects an incorrect passkey with 401', async () => {
    mockFindByIdSelect(
      makeUserDoc({ passkey: 'enc', comparePasskey: jest.fn().mockResolvedValue(false) })
    );
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '999888' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Invalid passkey');
  });

  it('accepts a correct passkey and reports verification only', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: 'enc' }));
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data).toEqual({ verified: true });
  });

  it('issues no token on ordinary verification — it is not a login', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: 'enc' }));
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(payloadOf(res).data.dummyToken).toBeUndefined();
    expect(JSON.stringify(payloadOf(res))).not.toContain('eyJ');
  });

  // No attempt counter, lockout or delay exists on this path: a 6-digit PIN can
  // be probed indefinitely by an already-authenticated session. Documented.
  it('applies no lockout after repeated wrong attempts', async () => {
    const doc = makeUserDoc({ passkey: 'enc', comparePasskey: jest.fn().mockResolvedValue(false) });
    mockFindByIdSelect(doc);

    for (let attempt = 0; attempt < 12; attempt++) {
      const res = makeRes();
      await verifyPasskey(makeReq({ passkey: '999888' }), res);
      // Always the same 401 — never a 423/429 or a "too many attempts" branch.
      expect(res.status).toHaveBeenCalledWith(401);
      expect(payloadOf(res).message).toBe('Invalid passkey');
    }
    expect(doc.comparePasskey).toHaveBeenCalledTimes(12);
  });

  it('returns 500 when the lookup throws', async () => {
    (User.findById as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Failed to verify passkey');
  });
});

describe('verifyPasskey — duress passkey', () => {
  function mockDummyAccount(doc: any) {
    (User.findOne as jest.Mock).mockResolvedValue(doc);
  }

  function makeDummyDoc() {
    return makeUserDoc({
      _id: { toString: () => DUMMY_ID },
      email: 'dummy@example.com',
      activeSessions: [] as any[],
    });
  }

  it('is inert unless a dummy account email is configured', async () => {
    // DUMMY_PASSKEY defaults to '555555' but without DUMMY_USER_EMAIL the
    // branch is skipped entirely and the value is treated as an ordinary PIN.
    mockFindByIdSelect(makeUserDoc({ passkey: 'enc', comparePasskey: jest.fn().mockResolvedValue(false) }));
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '555555' }), res);

    expect(User.findOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('uses the documented default duress value when only the email is configured', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    const dummy = makeDummyDoc();
    mockDummyAccount(dummy);
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '555555' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.dummyEmail).toBe('dummy@example.com');
  });

  it('honours an overridden duress value and ignores the default once overridden', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    process.env.DUMMY_PASSKEY = '707707';
    mockDummyAccount(makeDummyDoc());

    const overridden = makeRes();
    await verifyPasskey(makeReq({ passkey: '707707' }), overridden);
    expect(payloadOf(overridden).data.dummyToken).toBeDefined();

    // The old default no longer triggers the duress branch.
    (User.findOne as jest.Mock).mockClear();
    mockFindByIdSelect(makeUserDoc({ passkey: 'enc', comparePasskey: jest.fn().mockResolvedValue(false) }));
    const oldDefault = makeRes();
    await verifyPasskey(makeReq({ passkey: '555555' }), oldDefault);
    expect(User.findOne).not.toHaveBeenCalled();
    expect(oldDefault.status).toHaveBeenCalledWith(401);
  });

  it('issues a token for the dummy account, not for the authenticated actor', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    mockDummyAccount(makeDummyDoc());
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '555555' }), res);

    const decoded = jwt.verify(payloadOf(res).data.dummyToken, TEST_SECRET) as any;
    expect(decoded.userId).toBe(DUMMY_ID);
    expect(decoded.userId).not.toBe(USER_ID);
    expect(decoded.email).toBe('dummy@example.com');
  });

  it('registers a real revocable session for the dummy account', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    const dummy = makeDummyDoc();
    mockDummyAccount(dummy);
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '555555' }), res);

    expect(dummy.activeSessions).toHaveLength(1);
    const decoded = jwt.decode(payloadOf(res).data.dummyToken) as any;
    // Unlike the biometric path, this token carries a jti tracked on the account.
    expect(decoded.jti).toBe(dummy.activeSessions[0].jti);
    expect(dummy.save).toHaveBeenCalledTimes(1);
  });

  it('only matches an active dummy account', async () => {
    process.env.DUMMY_USER_EMAIL = 'Dummy@Example.com';
    mockDummyAccount(makeDummyDoc());

    await verifyPasskey(makeReq({ passkey: '555555' }), makeRes());

    expect(User.findOne).toHaveBeenCalledWith({ email: 'dummy@example.com', isActive: true });
  });

  it('falls through to normal verification when the dummy account is missing', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    mockDummyAccount(null);
    mockFindByIdSelect(makeUserDoc({ passkey: 'enc', comparePasskey: jest.fn().mockResolvedValue(false) }));
    const res = makeRes();

    await verifyPasskey(makeReq({ passkey: '555555' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Invalid passkey');
  });

  it('reports the same success message as a normal verification, hiding the duress branch', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    mockDummyAccount(makeDummyDoc());
    const duress = makeRes();
    await verifyPasskey(makeReq({ passkey: '555555' }), duress);

    mockFindByIdSelect(makeUserDoc({ passkey: 'enc' }));
    const normal = makeRes();
    await verifyPasskey(makeReq({ passkey: VALID_PASSKEY }), normal);

    expect(payloadOf(duress).message).toBe(payloadOf(normal).message);
    expect(payloadOf(duress).data.verified).toBe(true);
  });

  it('bypasses the actor’s own passkey entirely — their stored PIN is never compared', async () => {
    process.env.DUMMY_USER_EMAIL = 'dummy@example.com';
    mockDummyAccount(makeDummyDoc());
    const actorDoc = makeUserDoc({ passkey: 'enc' });
    mockFindByIdSelect(actorDoc);

    await verifyPasskey(makeReq({ passkey: '555555' }), makeRes());

    expect(actorDoc.comparePasskey).not.toHaveBeenCalled();
  });
});

describe('changePasskey', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('requires a new passkey', async () => {
    const res = makeRes();

    await changePasskey(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('New passkey is required');
  });

  it('applies the same pattern rules as setPasskey', async () => {
    for (const [passkey, message] of [
      ['000000', 'Cannot be all identical digits (e.g. 000000, 111111)'],
      ['123456', 'Cannot be a sequential pattern (e.g. 123456, 654321)'],
      ['abc123', 'Must be exactly 6 digits (0–9 only)'],
    ]) {
      const res = makeRes();
      await changePasskey(makeReq({ newPasskey: passkey }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe(message);
    }
  });

  it('returns 404 when the user no longer exists', async () => {
    mockFindByIdSelect(null);
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('replaces the stored passkey and audits the change', async () => {
    const doc = makeUserDoc({ passkey: 'old-encrypted' });
    mockFindByIdSelect(doc);
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }), res);

    expect(doc.passkey).not.toBe('old-encrypted');
    expect(decrypt(doc.passkey)).toBe(VALID_PASSKEY);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(AuditLog.logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_passkey_changed' })
    );
  });

  // FINDING (new, documented not fixed): changePasskey never asks for the
  // current passkey — the production comment says so explicitly. Anyone holding
  // a valid session token can silently replace the second factor without
  // knowing it, so the passkey adds no protection against a stolen session.
  // Contrast updatePassword, which does require the current password.
  it('requires no knowledge of the current passkey to replace it', async () => {
    const doc = makeUserDoc({ passkey: 'old-encrypted' });
    mockFindByIdSelect(doc);
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.comparePasskey).not.toHaveBeenCalled();
  });

  it('doubles as a set operation when no passkey exists yet', async () => {
    const doc = makeUserDoc({ passkey: undefined });
    mockFindByIdSelect(doc);
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.passkey).toBeDefined();
  });

  it('never echoes the new passkey in the response', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: 'old' }));
    const res = makeRes();

    await changePasskey(makeReq({ newPasskey: VALID_PASSKEY }), res);

    expect(JSON.stringify(payloadOf(res))).not.toContain(VALID_PASSKEY);
  });
});

describe('checkPasskeyStatus', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await checkPasskeyStatus(makeReq({}, null), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('reports only whether a passkey exists, never its value', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: 'encrypted-secret-value' }));
    const res = makeRes();

    await checkPasskeyStatus(makeReq(), res);

    expect(payloadOf(res).data).toEqual({ hasPasskey: true });
    expect(JSON.stringify(payloadOf(res))).not.toContain('encrypted-secret-value');
  });

  it('reports false when no passkey is configured', async () => {
    mockFindByIdSelect(makeUserDoc({ passkey: undefined }));
    const res = makeRes();

    await checkPasskeyStatus(makeReq(), res);

    expect(payloadOf(res).data).toEqual({ hasPasskey: false });
  });

  it('returns 404 when the user no longer exists', async () => {
    mockFindByIdSelect(null);
    const res = makeRes();

    await checkPasskeyStatus(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
