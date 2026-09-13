/**
 * Personal Files module permission gate.
 *
 * Two properties are under test, and the second one matters more than the first:
 *
 * 1. The gate honours permissions.modules.personalFiles.<action>, and an explicit
 *    `false` denies - that is the feature being added.
 * 2. The gate NEVER widens access to another user's files. It answers only "may
 *    this user use the feature?"; which documents they may touch is decided
 *    separately by the controller's `userId: req.user._id` scoping. In particular
 *    the super-admin fast path must not be mistaken for an ownership bypass.
 */

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { requirePersonalFilesPermission } from '../auth';

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

/** User.findById(...).select(...) resolving to the given permission subtree. */
function mockUserPerms(personalFiles: any) {
  (User.findById as jest.Mock).mockReturnValue({
    select: jest.fn().mockResolvedValue(
      personalFiles === 'no-user' ? null : { permissions: { modules: { personalFiles } } }
    ),
  });
}

function statusOf(res: any): number {
  return (res.status as jest.Mock).mock.calls[0]?.[0];
}

const ACTIONS: Array<'view' | 'create' | 'edit' | 'delete'> = ['view', 'create', 'edit', 'delete'];

describe('requirePersonalFilesPermission - granting and denying', () => {
  it.each(ACTIONS)('allows %s when the flag is true', async (action) => {
    mockUserPerms({ view: true, create: true, edit: true, delete: true });
    const next = jest.fn();
    const res = makeRes();

    await requirePersonalFilesPermission(action)(makeReq(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('denies %s with 403 when the flag is explicitly false', async (action) => {
    mockUserPerms({ view: false, create: false, edit: false, delete: false });
    const next = jest.fn();
    const res = makeRes();

    await requirePersonalFilesPermission(action)(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
    expect(res.__body.success).toBe(false);
  });

  it('gates each action independently - view granted, create revoked', async () => {
    mockUserPerms({ view: true, create: false, edit: true, delete: true });

    const viewNext = jest.fn();
    await requirePersonalFilesPermission('view')(makeReq(), makeRes(), viewNext);
    expect(viewNext).toHaveBeenCalled();

    const createNext = jest.fn();
    const createRes = makeRes();
    await requirePersonalFilesPermission('create')(makeReq(), createRes, createNext);
    expect(createNext).not.toHaveBeenCalled();
    expect(statusOf(createRes)).toBe(403);
  });

  it('gates delete independently of edit', async () => {
    mockUserPerms({ view: true, create: true, edit: true, delete: false });

    const editNext = jest.fn();
    await requirePersonalFilesPermission('edit')(makeReq(), makeRes(), editNext);
    expect(editNext).toHaveBeenCalled();

    const deleteNext = jest.fn();
    const deleteRes = makeRes();
    await requirePersonalFilesPermission('delete')(makeReq(), deleteRes, deleteNext);
    expect(deleteNext).not.toHaveBeenCalled();
    expect(statusOf(deleteRes)).toBe(403);
  });

  it('rejects an unauthenticated request with 401 and never queries the database', async () => {
    const next = jest.fn();
    const res = makeRes();

    await requirePersonalFilesPermission('view')(makeReq({ user: undefined }), res, next);

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

    await requirePersonalFilesPermission('view')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(500);
  });
});

describe('requirePersonalFilesPermission - backward compatibility', () => {
  it('grants access when the module is absent entirely', async () => {
    // Personal Files shipped ungated, so an absent flag means "this user predates
    // the permission" and must not silently lose their own drive.
    mockUserPerms(undefined);
    const next = jest.fn();

    await requirePersonalFilesPermission('view')(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('grants an action whose flag is missing from a partial module object', async () => {
    mockUserPerms({ view: true });
    const next = jest.fn();

    await requirePersonalFilesPermission('create')(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('still denies an explicit false inside an otherwise partial object', async () => {
    mockUserPerms({ view: true, delete: false });
    const next = jest.fn();
    const res = makeRes();

    await requirePersonalFilesPermission('delete')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });
});

describe('requirePersonalFilesPermission - no ownership bypass', () => {
  it('lets a superadmin through the FEATURE gate without consulting permissions', async () => {
    const next = jest.fn();

    await requirePersonalFilesPermission('delete')(
      makeReq({ user: { _id: USER_A, role: 'superadmin' } }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('never puts another user id on the request, for any role', async () => {
    // The only thing the controller scopes its queries by is req.user._id. If this
    // middleware could change it, an admin could reach someone else's files - so
    // assert it is left strictly alone.
    for (const role of ['member', 'manager', 'admin', 'superadmin']) {
      mockUserPerms({ view: true, create: true, edit: true, delete: true });
      const req = makeReq({ user: { _id: USER_A, role } });
      const next = jest.fn();

      await requirePersonalFilesPermission('view')(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
      expect(req.user._id).toBe(USER_A);
      expect(Object.keys(req.user).sort()).toEqual(['_id', 'role']);
    }
  });

  it('reads only the caller’s own permission document', async () => {
    mockUserPerms({ view: true });

    await requirePersonalFilesPermission('view')(makeReq(), makeRes(), jest.fn());

    // Scoped to the authenticated user, and only the one narrow field.
    expect(User.findById).toHaveBeenCalledWith(USER_A);
    const chain = (User.findById as jest.Mock).mock.results[0].value;
    expect(chain.select).toHaveBeenCalledWith('permissions.modules.personalFiles');
  });

  it('does not accept a target user id from params, body or query', async () => {
    mockUserPerms({ view: true });
    const req = makeReq({
      params: { userId: 'someone-else' },
      body: { userId: 'someone-else' },
      query: { userId: 'someone-else' },
    });

    await requirePersonalFilesPermission('view')(req, makeRes(), jest.fn());

    // Only the session's own id is ever looked up.
    expect(User.findById).toHaveBeenCalledTimes(1);
    expect(User.findById).toHaveBeenCalledWith(USER_A);
  });
});
