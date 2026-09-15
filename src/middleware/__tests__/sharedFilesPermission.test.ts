/**
 * Shared Files module permission gate.
 *
 * Two properties under test:
 *
 * 1. The gate honours permissions.modules.sharedFiles.<action>, per action.
 * 2. Its DEFAULT is closed. Unlike requirePersonalFilesPermission (which grants a
 *    missing flag because Personal Files predates its permission), Shared Files is
 *    a new opt-in module on a GLOBAL repository: a missing module, a missing flag,
 *    or anything other than an explicit `true` must deny. This is what keeps the
 *    server in agreement with the client (sidebar hidden, page Access Denied).
 */

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { requireSharedFilesPermission } from '../auth';

const USER_A = '507f1f77bcf86cd799439011';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn((body: any) => {
    res.__body = body;
    return res;
  });
  return res;
}

function makeReq(overrides: any = {}) {
  return { user: { _id: USER_A, role: 'member' }, params: {}, body: {}, query: {}, ...overrides } as any;
}

function mockUserPerms(sharedFiles: any) {
  (User.findById as jest.Mock).mockReturnValue({
    select: jest.fn().mockResolvedValue(
      sharedFiles === 'no-user' ? null : { permissions: { modules: { sharedFiles } } }
    ),
  });
}

function statusOf(res: any): number {
  return (res.status as jest.Mock).mock.calls[0]?.[0];
}

const ACTIONS: Array<'view' | 'create' | 'edit' | 'delete'> = ['view', 'create', 'edit', 'delete'];

describe('requireSharedFilesPermission - granting and denying', () => {
  it.each(ACTIONS)('allows %s when the flag is true', async (action) => {
    mockUserPerms({ view: true, create: true, edit: true, delete: true });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission(action)(makeReq(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('denies %s with 403 when the flag is explicitly false', async (action) => {
    mockUserPerms({ view: false, create: false, edit: false, delete: false });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission(action)(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
    expect(res.__body.success).toBe(false);
  });

  it('gates each action independently - view granted, create revoked (the "User B" case)', async () => {
    mockUserPerms({ view: true, create: false, edit: false, delete: false });

    const viewNext = jest.fn();
    await requireSharedFilesPermission('view')(makeReq(), makeRes(), viewNext);
    expect(viewNext).toHaveBeenCalled();

    for (const action of ['create', 'edit', 'delete'] as const) {
      const next = jest.fn();
      const res = makeRes();
      await requireSharedFilesPermission(action)(makeReq(), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(statusOf(res)).toBe(403);
    }
  });

  it('rejects an unauthenticated request with 401 and never queries the database', async () => {
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq({ user: undefined }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('fails closed when the permission lookup throws', async () => {
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(500);
  });
});

describe('requireSharedFilesPermission - closed by default (differs from Personal Files)', () => {
  it('DENIES when the module is absent entirely', async () => {
    mockUserPerms(undefined);
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it('DENIES an action whose flag is missing from a partial module object', async () => {
    mockUserPerms({ view: true });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('create')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it('DENIES when the user record cannot be found', async () => {
    mockUserPerms('no-user');
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', {}],
    ['null', null],
  ])('DENIES a truthy-but-not-boolean flag: %s', async (_label, value) => {
    // Only a literal boolean true grants; nothing coerces.
    mockUserPerms({ view: value });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it('is not influenced by the personalFiles permission', async () => {
    // A user fully permitted on Personal Files but never granted Shared Files must
    // still be denied - the two modules are unrelated.
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({
        permissions: {
          modules: { personalFiles: { view: true, create: true, edit: true, delete: true } },
        },
      }),
    });
    const next = jest.fn();
    const res = makeRes();

    await requireSharedFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });
});

describe('requireSharedFilesPermission - scope of the lookup', () => {
  it('lets a superadmin through the FEATURE gate without consulting permissions', async () => {
    // Same fast path as the other per-action module gates in this file.
    const next = jest.fn();

    await requireSharedFilesPermission('delete')(
      makeReq({ user: { _id: USER_A, role: 'superadmin' } }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('grants nothing to admin or manager roles by role alone', async () => {
    for (const role of ['admin', 'manager', 'member']) {
      mockUserPerms({ view: false });
      const next = jest.fn();
      const res = makeRes();

      await requireSharedFilesPermission('view')(makeReq({ user: { _id: USER_A, role } }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusOf(res)).toBe(403);
    }
  });

  it('reads only the caller’s own permission document, and only the sharedFiles field', async () => {
    mockUserPerms({ view: true });

    await requireSharedFilesPermission('view')(makeReq(), makeRes(), jest.fn());

    expect(User.findById).toHaveBeenCalledWith(USER_A);
    const chain = (User.findById as jest.Mock).mock.results[0].value;
    expect(chain.select).toHaveBeenCalledWith('permissions.modules.sharedFiles');
  });

  it('does not accept a target user id from params, body or query', async () => {
    mockUserPerms({ view: true });
    const req = makeReq({
      params: { userId: 'someone-else' },
      body: { userId: 'someone-else' },
      query: { userId: 'someone-else' },
    });

    await requireSharedFilesPermission('view')(req, makeRes(), jest.fn());

    expect(User.findById).toHaveBeenCalledTimes(1);
    expect(User.findById).toHaveBeenCalledWith(USER_A);
  });

  it('leaves req.user untouched', async () => {
    mockUserPerms({ view: true });
    const req = makeReq();

    await requireSharedFilesPermission('view')(req, makeRes(), jest.fn());

    expect(req.user._id).toBe(USER_A);
    expect(Object.keys(req.user).sort()).toEqual(['_id', 'role']);
  });
});
