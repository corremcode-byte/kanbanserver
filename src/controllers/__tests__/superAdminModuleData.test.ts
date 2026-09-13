/**
 * Module-data access: GET /api/users/:userId/module-data
 *
 * The route is labelled "Super admin — module data for a specific user" and is
 * mounted with authenticate only (see dataAccessWiring.test.ts). These tests
 * establish what the controller itself enforces.
 *
 * Actor/target model: USER_A is the authenticated caller, USER_B is an
 * unrelated account whose data is being requested.
 */

jest.mock('../../models/User', () => {
  const User: any = { findById: jest.fn() };
  return { __esModule: true, default: User, User };
});

jest.mock('../../models/Task', () => {
  const Task: any = { find: jest.fn(), countDocuments: jest.fn() };
  return { __esModule: true, default: Task, Task };
});

jest.mock('../../models/Project', () => {
  const Project: any = { find: jest.fn() };
  return { __esModule: true, default: Project, Project };
});

jest.mock('../../models/Note', () => {
  const Note: any = { find: jest.fn() };
  return { __esModule: true, default: Note, Note };
});

jest.mock('../../models/ChatGroup', () => ({
  ChatGroup: { find: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import User from '../../models/User';
import Task from '../../models/Task';
import Project from '../../models/Project';
import Note from '../../models/Note';
import { ChatGroup } from '../../models/ChatGroup';
import { getAdminUserModuleData } from '../superAdminController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** Actor defaults to USER_A as an ordinary member. */
function makeReq(params: any, query: any = {}, user: any = { _id: USER_A, role: 'member' }) {
  return { params, query, body: {}, user } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** A chainable find(): .sort().limit().select().populate().lean() */
function mockChain(model: any, resolved: any[]) {
  const chain: any = {};
  for (const method of ['sort', 'limit', 'select', 'populate']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn().mockResolvedValue(resolved);
  (model.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  (User.findById as jest.Mock).mockResolvedValue({
    _id: USER_B,
    displayName: 'User B',
    lastLoginAt: new Date('2026-01-01'),
    createdAt: new Date('2025-01-01'),
  });
  (Task.countDocuments as jest.Mock).mockResolvedValue(0);
  mockChain(Task, []);
  mockChain(Project, []);
  mockChain(Note, []);
  mockChain(ChatGroup, []);
});

describe('getAdminUserModuleData — input validation', () => {
  it('rejects a malformed user id with 400', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: 'not-an-objectid' }, { module: 'tasks' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid user ID');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects an empty user id', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: '' }, { module: 'tasks' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for a nonexistent target user', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'tasks' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('User not found');
    expect(Task.find).not.toHaveBeenCalled();
  });

  it('rejects an unknown module name with 400', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'payroll' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid module');
  });

  it('rejects a missing module query parameter with 400', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid module');
  });

  it('treats module names case-sensitively', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'Tasks' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid module');
  });

  it('returns 500 without leaking internals when a query throws', async () => {
    (User.findById as jest.Mock).mockRejectedValue(new Error('mongo down on shard-9'));
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'tasks' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(payloadOf(res))).not.toContain('shard-9');
  });
});

describe('getAdminUserModuleData — per-module scoping to the TARGET user', () => {
  it('scopes dashboard counts to the target user, not the caller', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'dashboard' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Every count filter must reference USER_B, never the authenticated USER_A.
    for (const call of (Task.countDocuments as jest.Mock).mock.calls) {
      expect(JSON.stringify(call[0])).toContain(USER_B);
      expect(JSON.stringify(call[0])).not.toContain(USER_A);
    }
  });

  it('returns dashboard fields including the target’s login and creation times', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'dashboard' }), res);

    expect(Object.keys(payloadOf(res).data).sort()).toEqual(
      ['assigned', 'completed', 'created', 'createdAt', 'lastLoginAt', 'overdue'].sort()
    );
  });

  it('returns tasks assigned to or created by the target user', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'tasks' }), res);

    const filter = (Task.find as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(filter)).toContain(USER_B);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(payloadOf(res).data).toHaveProperty('tasks');
  });

  it('returns projects the target owns, co-owns or is a member of', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'projects' }), res);

    expect(JSON.stringify((Project.find as jest.Mock).mock.calls[0][0])).toContain(USER_B);
    expect(payloadOf(res).data).toHaveProperty('projects');
  });

  it('returns notes owned by or shared with the target', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'notes' }), res);

    expect(JSON.stringify((Note.find as jest.Mock).mock.calls[0][0])).toContain(USER_B);
    expect(payloadOf(res).data).toHaveProperty('notes');
  });

  it('returns chat groups the target belongs to', async () => {
    const res = makeRes();

    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'chats' }), res);

    expect(JSON.stringify((ChatGroup.find as jest.Mock).mock.calls[0][0])).toContain(USER_B);
    expect(payloadOf(res).data).toHaveProperty('groups');
  });

  it('caps each list module at 50 records', async () => {
    for (const [module, model] of [
      ['tasks', Task],
      ['projects', Project],
      ['notes', Note],
      ['chats', ChatGroup],
    ] as Array<[string, any]>) {
      const chain = mockChain(model, []);
      await getAdminUserModuleData(makeReq({ userId: USER_B }, { module }), makeRes());
      expect(chain.limit).toHaveBeenCalledWith(50);
    }
  });

  it('queries only the model belonging to the requested module', async () => {
    await getAdminUserModuleData(makeReq({ userId: USER_B }, { module: 'notes' }), makeRes());

    expect(Note.find).toHaveBeenCalledTimes(1);
    expect(Task.find).not.toHaveBeenCalled();
    expect(Project.find).not.toHaveBeenCalled();
    expect(ChatGroup.find).not.toHaveBeenCalled();
  });
});

describe('getAdminUserModuleData — authorization (IDOR regression)', () => {
  // SECURITY FINDING (documented, NOT fixed): the route is labelled
  // "Super admin — module data for a specific user" and the handler lives in
  // superAdminController, but it performs no role check and the route carries
  // no requireSuperAdmin / requireAdmin middleware. Any authenticated user can
  // read any other user's tasks, projects, notes and chat groups simply by
  // putting that user's id in the path.
  //
  // These tests assert the behaviour as it exists today, so a future fix will
  // fail them loudly rather than silently changing an untested contract.
  it('lets an ordinary member read another user’s tasks', async () => {
    mockChain(Task, [{ _id: 't1', title: 'User B private task', status: 'todo' }]);
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'tasks' }, { _id: USER_A, role: 'member' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.tasks).toHaveLength(1);
  });

  it('lets an ordinary member read another user’s projects', async () => {
    mockChain(Project, [{ _id: 'p1', name: 'User B private project' }]);
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'projects' }, { _id: USER_A, role: 'member' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.projects).toHaveLength(1);
  });

  it('lets an ordinary member read another user’s notes, decrypted', async () => {
    mockChain(Note, [{ _id: 'n1', title: 'Private note', content: 'secret content' }]);
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'notes' }, { _id: USER_A, role: 'member' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.notes).toHaveLength(1);
  });

  it('lets an ordinary member read another user’s chat group memberships', async () => {
    mockChain(ChatGroup, [{ _id: 'g1', name: 'Private group', members: [] }]);
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'chats' }, { _id: USER_A, role: 'member' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.groups).toHaveLength(1);
  });

  it('never consults the caller’s role or identity at any point', async () => {
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'tasks' }, { _id: USER_A, role: 'member' }),
      res
    );

    // Only the TARGET user is looked up — the caller is never loaded or checked.
    expect(User.findById).toHaveBeenCalledTimes(1);
    expect(User.findById).toHaveBeenCalledWith(USER_B);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('behaves identically for a member and a superadmin caller', async () => {
    mockChain(Task, [{ _id: 't1', title: 'Task' }]);
    const member = makeRes();
    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'tasks' }, { _id: USER_A, role: 'member' }),
      member
    );

    mockChain(Task, [{ _id: 't1', title: 'Task' }]);
    const superadmin = makeRes();
    await getAdminUserModuleData(
      makeReq({ userId: USER_B }, { module: 'tasks' }, { _id: USER_A, role: 'superadmin' }),
      superadmin
    );

    expect(payloadOf(member)).toEqual(payloadOf(superadmin));
  });

  it('serves a caller with no user object at all, since req.user is never read', async () => {
    // The route's authenticate middleware is what supplies req.user; the
    // handler itself would not notice its absence.
    const res = makeRes();

    await getAdminUserModuleData({ params: { userId: USER_B }, query: { module: 'tasks' } } as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reads a user’s own data through the same path', async () => {
    // The allowed baseline: a caller requesting their own id.
    mockChain(Task, [{ _id: 't1', title: 'My task' }]);
    const res = makeRes();

    await getAdminUserModuleData(
      makeReq({ userId: USER_A }, { module: 'tasks' }, { _id: USER_A, role: 'member' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(JSON.stringify((Task.find as jest.Mock).mock.calls[0][0])).toContain(USER_A);
  });
});
