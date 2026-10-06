/**
 * Confluence module permission gate.
 *
 * Same contract as requireSharedFilesPermission: per-action, super admin passes,
 * and the DEFAULT is closed — a missing module, a missing flag, or anything other
 * than an explicit `true` denies. Confluence is a new opt-in module.
 */

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User } from '../../models';
import { requireConfluencePermission, ConfluenceAction } from '../auth';

const USER_A = '507f1f77bcf86cd799439011';
const ACTIONS: ConfluenceAction[] = ['view', 'create', 'edit', 'comment', 'publish', 'delete'];

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

function mockUserPerms(confluence: any) {
  (User.findById as jest.Mock).mockReturnValue({
    select: jest.fn().mockResolvedValue(
      confluence === 'no-user' ? null : { permissions: { modules: { confluence } } }
    ),
  });
}

const statusOf = (res: any): number => (res.status as jest.Mock).mock.calls[0]?.[0];

describe('requireConfluencePermission', () => {
  it.each(ACTIONS)('allows %s when the flag is true', async (action) => {
    mockUserPerms({ [action]: true });
    const next = jest.fn();
    const res = makeRes();
    await requireConfluencePermission(action)(makeReq(), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('denies %s with 403 when the flag is false', async (action) => {
    mockUserPerms({ view: true, create: true, edit: true, comment: true, publish: true, delete: true, [action]: false });
    const next = jest.fn();
    const res = makeRes();
    await requireConfluencePermission(action)(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
    expect(res.__body.success).toBe(false);
  });

  it('gates each action independently (view granted, publish not)', async () => {
    mockUserPerms({ view: true, create: true, publish: false });
    const res = makeRes();
    const next = jest.fn();
    await requireConfluencePermission('publish')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it.each([
    ['a missing module', undefined],
    ['an empty module', {}],
    ['a truthy non-boolean flag', { view: 'true' }],
    ['a missing user document', 'no-user'],
  ])('fails closed on %s', async (_label, perms) => {
    mockUserPerms(perms);
    const res = makeRes();
    const next = jest.fn();
    await requireConfluencePermission('view')(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusOf(res)).toBe(403);
  });

  it('lets a super admin through without reading permissions', async () => {
    const next = jest.fn();
    await requireConfluencePermission('delete')(makeReq({ user: { _id: USER_A, role: 'superadmin' } }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('responds 401 without an authenticated user', async () => {
    const res = makeRes();
    const next = jest.fn();
    await requireConfluencePermission('view')(makeReq({ user: undefined }), res, next);
    expect(statusOf(res)).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 500 (and does not call next) when the permission lookup throws', async () => {
    (User.findById as jest.Mock).mockReturnValue({ select: jest.fn().mockRejectedValue(new Error('db down')) });
    const res = makeRes();
    const next = jest.fn();
    await requireConfluencePermission('view')(makeReq(), res, next);
    expect(statusOf(res)).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
