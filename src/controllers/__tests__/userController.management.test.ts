/**
 * User management: activation, role changes, permission reads and the
 * admin-facing passkey endpoints.
 *
 * Actor/target model: ACTOR is the authenticated caller; TARGET is another
 * account being administered. Role alone grants nothing here — every gate is a
 * modules.userManagement.* permission flag.
 */

jest.mock('../../models', () => ({
  User: { find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() },
  Project: { find: jest.fn(), findById: jest.fn() },
  Task: { find: jest.fn() },
  Notification: { deleteMany: jest.fn() },
  AuditLog: { logSystemEvent: jest.fn(), logAction: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('../../services/emailService', () => ({
  emailService: { sendEmail: jest.fn() },
}));

import { User } from '../../models';
import { encrypt, decrypt } from '../../utils/encryption';
import {
  toggleUserActiveStatus,
  updateUserRole,
  getUserPermissions,
  getUserPasskey,
} from '../userController';

const ACTOR = '507f1f77bcf86cd799439011';
const TARGET = '507f1f77bcf86cd799439022';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: ACTOR, email: 'actor@example.com', displayName: 'Actor', role: 'member' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** The acting user, with a userManagement permission map. */
function makeActor(userManagement: Record<string, any> = {}) {
  return { _id: ACTOR, email: 'actor@example.com', permissions: { modules: { userManagement } } };
}

function makeTargetUser(overrides: Record<string, any> = {}) {
  return {
    _id: TARGET,
    email: 'target@example.com',
    displayName: 'Target',
    role: 'member',
    isActive: true,
    passkey: undefined as any,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('toggleUserActiveStatus — permission gate', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await toggleUserActiveStatus(makeReq({ user: null, params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('denies a caller without the deactivateActivateUsers flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain("don't have permission to modify user status");
  });

  it('denies a caller whose flag is explicitly false', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({ deactivateActivateUsers: false }));
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Role is deliberately not consulted — the production comment says
  // "Admin role no longer bypasses permission checks."
  it('denies an admin and a superadmin who lack the flag', async () => {
    for (const role of ['admin', 'superadmin']) {
      (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
      const res = makeRes();

      await toggleUserActiveStatus(
        makeReq({
          params: { userId: TARGET },
          body: { isActive: false },
          user: { _id: ACTOR, role },
        }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('refuses to let a caller change their own status', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({ deactivateActivateUsers: true }));
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: ACTOR }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('You cannot modify your own account status.');
  });

  it('returns 404 for a nonexistent target', async () => {
    (User.findById as jest.Mock)
      .mockResolvedValueOnce(makeActor({ deactivateActivateUsers: true }))
      .mockResolvedValueOnce(null);
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deactivates the target for a permitted caller', async () => {
    const target = makeTargetUser();
    (User.findById as jest.Mock)
      .mockResolvedValueOnce(makeActor({ deactivateActivateUsers: true }))
      .mockResolvedValueOnce(target);
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(target.isActive).toBe(false);
    expect(target.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reactivates the target when isActive is true', async () => {
    const target = makeTargetUser({ isActive: false });
    (User.findById as jest.Mock)
      .mockResolvedValueOnce(makeActor({ deactivateActivateUsers: true }))
      .mockResolvedValueOnce(target);
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: true } }),
      res
    );

    expect(target.isActive).toBe(true);
    expect(payloadOf(res).message).toContain('activated');
  });

  it('reads the permission map through toObject when it is a Mongoose subdocument', async () => {
    (User.findById as jest.Mock)
      .mockResolvedValueOnce({
        _id: ACTOR,
        permissions: {
          modules: {
            userManagement: { toObject: () => ({ deactivateActivateUsers: true }) },
          },
        },
      })
      .mockResolvedValueOnce(makeTargetUser());
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 when the save fails', async () => {
    (User.findById as jest.Mock)
      .mockResolvedValueOnce(makeActor({ deactivateActivateUsers: true }))
      .mockResolvedValueOnce(
        makeTargetUser({ save: jest.fn().mockRejectedValue(new Error('write failed')) })
      );
    const res = makeRes();

    await toggleUserActiveStatus(
      makeReq({ params: { userId: TARGET }, body: { isActive: false } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateUserRole — permission gate and role validation', () => {
  it('denies a caller without the managePermissions flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
    const res = makeRes();

    await updateUserRole(makeReq({ params: { userId: TARGET }, body: { role: 'admin' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain("don't have permission to modify user roles");
  });

  it('rejects a role outside the allowed set', async () => {
    for (const role of ['superadmin', 'owner', '', undefined, 'ADMIN']) {
      (User.findById as jest.Mock).mockResolvedValue(makeActor({ managePermissions: true }));
      const res = makeRes();

      await updateUserRole(makeReq({ params: { userId: TARGET }, body: { role } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Invalid role. Must be admin, member, or manager.');
    }
  });

  // Notably superadmin cannot be assigned through this endpoint at all.
  it('accepts each of the three assignable roles', async () => {
    for (const role of ['admin', 'member', 'manager']) {
      const target = makeTargetUser();
      (User.findById as jest.Mock)
        .mockResolvedValueOnce(makeActor({ managePermissions: true }))
        .mockResolvedValueOnce(target);
      const res = makeRes();

      await updateUserRole(makeReq({ params: { userId: TARGET }, body: { role } }), res);

      expect(target.role).toBe(role);
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });

  it('refuses to let a caller change their own role', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({ managePermissions: true }));
    const res = makeRes();

    await updateUserRole(makeReq({ params: { userId: ACTOR }, body: { role: 'admin' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('You cannot modify your own role.');
  });

  it('returns 404 for a nonexistent target', async () => {
    (User.findById as jest.Mock)
      .mockResolvedValueOnce(makeActor({ managePermissions: true }))
      .mockResolvedValueOnce(null);
    const res = makeRes();

    await updateUserRole(makeReq({ params: { userId: TARGET }, body: { role: 'admin' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('does not let a superadmin role bypass the permission flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
    const res = makeRes();

    await updateUserRole(
      makeReq({
        params: { userId: TARGET },
        body: { role: 'admin' },
        user: { _id: ACTOR, role: 'superadmin' },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('getUserPermissions', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getUserPermissions(makeReq({ user: null, params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('denies a caller without a userManagement view/manage flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
    const res = makeRes();

    await getUserPermissions(makeReq({ params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('getUserPasskey — decrypted second factor exposure', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getUserPasskey(makeReq({ user: null, params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('denies a caller without the managePermissions flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeActor({}));
    const res = makeRes();

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain("don't have permission to view user passkeys");
  });

  it('returns 404 for a nonexistent target', async () => {
    (User.findById as jest.Mock).mockResolvedValueOnce(makeActor({ managePermissions: true }));
    (User.findById as jest.Mock).mockReturnValueOnce({
      select: jest.fn().mockResolvedValue(null),
    } as any);
    const res = makeRes();

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('reports hasPasskey false and a null value when none is set', async () => {
    (User.findById as jest.Mock).mockResolvedValueOnce(makeActor({ managePermissions: true }));
    (User.findById as jest.Mock).mockReturnValueOnce({
      select: jest.fn().mockResolvedValue(makeTargetUser({ passkey: undefined })),
    } as any);
    const res = makeRes();

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), res);

    expect(payloadOf(res).data).toEqual({ hasPasskey: false, passkey: null });
  });

  // SECURITY FINDING (documented, NOT fixed): the passkey is stored under
  // reversible encryption and this endpoint decrypts it, so any user holding
  // modules.userManagement.managePermissions can read another account's 6-digit
  // second factor in plaintext. Same shape as the plainPassword finding from
  // Batch 2. A fixture value is used here — no real secret.
  it('returns another user’s passkey in plaintext to a permitted caller', async () => {
    const FIXTURE_PIN = '481902';
    (User.findById as jest.Mock).mockResolvedValueOnce(makeActor({ managePermissions: true }));
    (User.findById as jest.Mock).mockReturnValueOnce({
      select: jest.fn().mockResolvedValue(makeTargetUser({ passkey: encrypt(FIXTURE_PIN) })),
    } as any);
    const res = makeRes();

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), res);

    expect(payloadOf(res).data.hasPasskey).toBe(true);
    expect(payloadOf(res).data.passkey).toBe(FIXTURE_PIN);
  });

  it('degrades to a null passkey rather than erroring when decryption fails', async () => {
    (User.findById as jest.Mock).mockResolvedValueOnce(makeActor({ managePermissions: true }));
    (User.findById as jest.Mock).mockReturnValueOnce({
      select: jest.fn().mockResolvedValue(makeTargetUser({ passkey: 'not-valid-ciphertext' })),
    } as any);
    const res = makeRes();

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), res);

    expect(payloadOf(res).data).toEqual({ hasPasskey: true, passkey: null });
  });

  it('selects the passkey field explicitly, since the schema excludes it', async () => {
    const select = jest.fn().mockResolvedValue(makeTargetUser());
    (User.findById as jest.Mock).mockResolvedValueOnce(makeActor({ managePermissions: true }));
    (User.findById as jest.Mock).mockReturnValueOnce({ select } as any);

    await getUserPasskey(makeReq({ params: { userId: TARGET } }), makeRes());

    expect(select).toHaveBeenCalledWith('+passkey');
  });

  it('round-trips the fixture through the same encryption helper the model uses', () => {
    // Confirms the storage form is reversible, which is what makes the above
    // endpoint able to return plaintext at all.
    const stored = encrypt('481902');
    expect(stored).not.toBe('481902');
    expect(decrypt(stored)).toBe('481902');
  });
});
