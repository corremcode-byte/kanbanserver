/**
 * Task CRUD data integrity: creation, update and deletion boundaries as the
 * controller actually implements them.
 *
 * Note on layering: POST/PUT/DELETE /api/tasks/:id are guarded by
 * checkPermission('canCreateTasks') / checkCanEditTask / checkCanDeleteTask
 * (covered in Batch 3). These tests exercise the *controller's own* second
 * layer of project-membership checks, which runs independently of that
 * middleware.
 */

jest.mock('../../models', () => ({
  Task: Object.assign(jest.fn(), {
    findOne: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
    reorderTasks: jest.fn(),
  }),
  Project: { findById: jest.fn(), find: jest.fn() },
  User: { findById: jest.fn(), find: jest.fn(), findOne: jest.fn() },
  AuditLog: { logAction: jest.fn() },
  Notification: { create: jest.fn(), insertMany: jest.fn() },
}));

jest.mock('../../models/AuditLog', () => ({
  AuditLog: { logAction: jest.fn(), logSystemEvent: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../socket', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })), emit: jest.fn() })),
}));

jest.mock('../../socket/socketHandlers', () => ({
  broadcastToProject: jest.fn(),
  broadcastToUser: jest.fn(),
}));

jest.mock('../../models/ProjectPermission', () => ({
  ProjectPermission: {
    findOne: jest.fn(),
    create: jest.fn(),
    getDefaultPermissions: jest.fn(() => ({ canEditTasks: true })),
  },
}));

jest.mock('../../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendTaskAssignmentEmail: jest.fn() },
}));

jest.mock('../notificationController', () => ({
  createNotification: jest.fn(),
}));

// tasksController resolves the User model through a dynamic import() on some
// notification paths; without this the real mongoose model is loaded and the
// query never settles.
jest.mock('../../models/User', () => {
  const chain = () => ({ select: jest.fn().mockResolvedValue(null) });
  const User: any = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(chain),
    findById: jest.fn().mockResolvedValue(null),
  };
  return { __esModule: true, User, default: User };
});

import { Task, Project, User } from '../../models';
import { AuditLog } from '../../models/AuditLog';
import { getTask, createTask, updateTask, deleteTask } from '../tasksController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const OWNER_B = '507f1f77bcf86cd799439033';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';
const TASK_A = '707f1f77bcf86cd7994390c1';
const TASK_B = '707f1f77bcf86cd7994390c2';

const FUTURE_DUE = '2030-01-01T00:00:00.000Z';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A' },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** Project A: owned by USER_B, USER_A is an ordinary member. */
function makeProjectA(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    name: 'Project A',
    ownerId: OWNER_B,
    owners: [OWNER_B] as any[],
    members: [USER_A, USER_B] as any[],
    managers: [] as any[],
    columns: [{ id: 'todo' }, { id: 'in-progress' }],
    ...overrides,
  };
}

/** Project B: USER_A has no relationship with it at all. */
function makeProjectB(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_B,
    name: 'Project B',
    ownerId: OWNER_B,
    owners: [OWNER_B] as any[],
    members: [USER_B] as any[],
    managers: [] as any[],
    columns: [{ id: 'todo' }],
    ...overrides,
  };
}

function makeTaskDoc(overrides: Record<string, any> = {}) {
  return {
    _id: TASK_A,
    title: 'A task',
    description: 'desc',
    projectId: PROJECT_A,
    createdBy: USER_B,
    assignedBy: USER_B,
    assignedTo: undefined as any,
    assignees: [] as any[],
    status: 'todo',
    listId: 'todo',
    priority: 'medium',
    isDeleted: false,
    ...overrides,
  };
}

/** Task.findOne(...).populate().populate()... — chainable, resolving to `doc`. */
function mockTaskFindOne(doc: any) {
  const chain: any = { populate: jest.fn(() => chain), sort: jest.fn(() => chain) };
  chain.then = (resolve: any) => Promise.resolve(doc).then(resolve);
  (Task.findOne as jest.Mock).mockReturnValue(chain);
  return chain;
}

/** Task.findByIdAndUpdate(...).populate()... — chainable, resolving to `doc`. */
function mockTaskUpdateReturns(doc: any) {
  const chain: any = { populate: jest.fn(() => chain) };
  chain.then = (resolve: any) => Promise.resolve(doc).then(resolve);
  (Task.findByIdAndUpdate as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  (AuditLog.logAction as jest.Mock).mockResolvedValue(undefined);
  (User.findById as jest.Mock).mockResolvedValue({
    _id: USER_A,
    permissions: { modules: { myTasks: { assignee: true } } },
  });
  (Project.findById as jest.Mock).mockResolvedValue(makeProjectA());
});

// ─────────────────────────────────────────────────────────────────────────────
// getTask
// ─────────────────────────────────────────────────────────────────────────────

describe('getTask — read isolation', () => {
  it('rejects a malformed ObjectId as not found rather than querying', async () => {
    const res = makeRes();

    await getTask(makeReq({ params: { id: 'not-an-objectid' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Task.findOne).not.toHaveBeenCalled();
  });

  it('excludes soft-deleted tasks from the lookup', async () => {
    mockTaskFindOne(null);

    await getTask(makeReq({ params: { id: TASK_A } }), makeRes());

    expect(Task.findOne).toHaveBeenCalledWith({ _id: TASK_A, isDeleted: { $ne: true } });
  });

  it('allows a project member to read a task in that project', async () => {
    mockTaskFindOne(makeTaskDoc());
    const res = makeRes();

    await getTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('denies a non-member reading a task belonging to another user’s project', async () => {
    mockTaskFindOne(makeTaskDoc({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await getTask(makeReq({ params: { id: TASK_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this task');
  });

  it('denies an unrelated user reading someone else’s standalone task', async () => {
    mockTaskFindOne(makeTaskDoc({ projectId: null, createdBy: USER_B, assignedBy: USER_B }));
    const res = makeRes();

    await getTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('allows the assignee of a standalone task to read it', async () => {
    mockTaskFindOne(
      makeTaskDoc({ projectId: null, createdBy: USER_B, assignedBy: USER_B, assignees: [USER_A] })
    );
    const res = makeRes();

    await getTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTask
// ─────────────────────────────────────────────────────────────────────────────

describe('createTask — required fields and validation', () => {
  it('requires a non-empty title', async () => {
    const res = makeRes();

    await createTask(makeReq({ body: { title: '   ', dueDate: FUTURE_DUE, projectId: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Task title is required');
  });

  it('requires a due date', async () => {
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'Task', projectId: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Due date is required');
  });

  it('rejects an unknown reminder frequency', async () => {
    const res = makeRes();

    await createTask(
      makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, reminderFrequency: 'every-second' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid reminder frequency');
  });

  it('rejects a custom reminder with a non-positive interval', async () => {
    const res = makeRes();

    await createTask(
      makeReq({
        body: { title: 'T', dueDate: FUTURE_DUE, reminderFrequency: 'custom', customReminderMinutes: 0 },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Custom reminder minutes must be at least 1');
  });

  it('returns 404 when the target project does not exist', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
  });

  it('requires the assignee permission before assigning to anyone', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { myTasks: { assignee: false } } },
    });
    const res = makeRes();

    await createTask(
      makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_A, assignees: [USER_B] } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain("don't have permission to assign tasks");
  });

  it('does not require the assignee permission for an unassigned task', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { myTasks: { assignee: false } } },
    });
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_B } }), res);

    // Falls through to the project-membership check rather than the 403 above.
    expect(payloadOf(res).message).toBe('Access denied to this project');
  });
});

describe('createTask — project access boundary', () => {
  it('denies creating a task in a project the user has no relationship with', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this project');
  });

  it('denies a view-only co-owner who is not a member or manager', async () => {
    // owners[] alone is not consulted by createTask — only ownerId/members/managers.
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectB({ owners: [OWNER_B, USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a project manager who is not in members', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectB({ managers: [USER_A], members: [USER_B] })
    );
    const res = makeRes();

    await createTask(makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_B } }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('resolves the project strictly from body.projectId', async () => {
    await createTask(
      makeReq({
        params: { projectId: PROJECT_B },
        body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_A },
      }),
      makeRes()
    );

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
    expect(Project.findById).not.toHaveBeenCalledWith(PROJECT_B);
  });

  it('treats the sentinel project ids as "no project" and skips the project lookup', async () => {
    for (const sentinel of ['__NO_PROJECT__', 'undefined', 'null', '   ']) {
      (Project.findById as jest.Mock).mockClear();

      await createTask(
        makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: sentinel } }),
        makeRes()
      );

      expect(Project.findById).not.toHaveBeenCalled();
    }
  });
});

describe('createTask — assignee scoping', () => {
  it('silently drops assignees who are not members, managers or the owner', async () => {
    const outsider = '507f1f77bcf86cd7994390ff';
    (Task.findOne as jest.Mock).mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });
    const res = makeRes();

    await createTask(
      makeReq({
        body: {
          title: 'T',
          dueDate: FUTURE_DUE,
          projectId: PROJECT_A,
          assignees: [USER_B, outsider],
        },
      }),
      res
    );

    // The controller filters against the project roster before constructing the task.
    const constructed = (Task as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.assignees).toEqual([USER_B]);
    expect(constructed.assignees).not.toContain(outsider);
  });

  it('forces createdBy and assignedBy to the authenticated user, ignoring the body', async () => {
    (Task.findOne as jest.Mock).mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });

    await createTask(
      makeReq({
        body: {
          title: 'T',
          dueDate: FUTURE_DUE,
          projectId: PROJECT_A,
          createdBy: USER_B,
          assignedBy: USER_B,
          order: 9999,
          isDeleted: true,
        },
      }),
      makeRes()
    );

    const constructed = (Task as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.createdBy).toBe(USER_A);
    expect(constructed.assignedBy).toBe(USER_A);
    // createTask builds an explicit field list, so these body keys never reach the model.
    expect(constructed.isDeleted).toBeUndefined();
    expect(constructed.order).toBe(0);
  });

  it('falls back to the project’s first column when the supplied listId is unknown', async () => {
    (Task.findOne as jest.Mock).mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });

    await createTask(
      makeReq({ body: { title: 'T', dueDate: FUTURE_DUE, projectId: PROJECT_A, listId: 'ghost-list' } }),
      makeRes()
    );

    const constructed = (Task as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.listId).toBe('todo');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateTask
// ─────────────────────────────────────────────────────────────────────────────

describe('updateTask — target resolution and access', () => {
  it('returns 404 for a nonexistent or soft-deleted task', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { title: 'New' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Task.findOne).toHaveBeenCalledWith({ _id: TASK_A, isDeleted: { $ne: true } });
  });

  it('denies updating a task whose project the user does not belong to', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_B }, body: { title: 'Hijacked' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this project');
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('derives the project from the stored task, never from a client-supplied projectId', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    // USER_A is a member of PROJECT_A and supplies it, hoping to be authorised
    // against the wrong project. The controller must ignore it.
    await updateTask(
      makeReq({ params: { id: TASK_B }, body: { title: 'Hijacked', projectId: PROJECT_A } }),
      res
    );

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_B);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when the task’s project has been deleted', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { title: 'New' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
  });

  it('allows a project member to update a task in that project', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    mockTaskUpdateReturns(makeTaskDoc({ title: 'Updated' }));
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { priority: 'high' } }), res);

    expect(Task.findByIdAndUpdate).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('applies the update to the task named in the route only', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    mockTaskUpdateReturns(makeTaskDoc());

    await updateTask(
      makeReq({ params: { id: TASK_A }, body: { priority: 'high', _id: TASK_B, id: TASK_B } }),
      makeRes()
    );

    expect((Task.findByIdAndUpdate as jest.Mock).mock.calls[0][0]).toBe(TASK_A);
  });

  it('requires the assignee permission to change assignees', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc({ assignees: [USER_B] }));
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { myTasks: { assignee: false } } },
    });
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { assignees: [USER_A] } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('permits resubmitting the identical assignee list without the assignee permission', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc({ assignees: [USER_B] }));
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { myTasks: { assignee: false } } },
    });
    mockTaskUpdateReturns(makeTaskDoc());
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { assignees: [USER_B] } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('drops assignees who are not on the project roster', async () => {
    const outsider = '507f1f77bcf86cd7994390ff';
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    mockTaskUpdateReturns(makeTaskDoc());

    await updateTask(
      makeReq({ params: { id: TASK_A }, body: { assignees: [USER_B, outsider] } }),
      makeRes()
    );

    const applied = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.assignees).toEqual([USER_B]);
  });
});

describe('updateTask — standalone task status authorization', () => {
  it('denies a status change by someone who is neither creator, assigner nor assignee', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(
      makeTaskDoc({ projectId: null, createdBy: USER_B, assignedBy: USER_B, assignees: [USER_B] })
    );
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { status: 'completed' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only the task creator or assigned user can update this task');
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('allows the creator to change the status of their standalone task', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(
      makeTaskDoc({ projectId: null, createdBy: USER_A, assignedBy: USER_B })
    );
    mockTaskUpdateReturns(makeTaskDoc({ projectId: null }));
    const res = makeRes();

    await updateTask(makeReq({ params: { id: TASK_A }, body: { status: 'completed' } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('normalises status and listId together on a standalone task', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(
      makeTaskDoc({ projectId: null, createdBy: USER_A })
    );
    mockTaskUpdateReturns(makeTaskDoc({ projectId: null }));

    await updateTask(makeReq({ params: { id: TASK_A }, body: { status: 'DONE' } }), makeRes());

    const applied = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.status).toBe('completed');
    expect(applied.listId).toBe('completed');
  });
});

describe('updateTask — mass assignment (documented, not fixed)', () => {
  // FINDING (documented, not fixed): updateTask assigns `const updates =
  // req.body` and passes `{ ...updates }` straight to findByIdAndUpdate with no
  // field whitelist. Any schema field a client names is written, including
  // provenance and soft-delete bookkeeping. createTask and updateProject both
  // build explicit field lists; this path does not.
  it('writes arbitrary client-supplied schema fields on a project task', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    mockTaskUpdateReturns(makeTaskDoc());

    await updateTask(
      makeReq({
        params: { id: TASK_A },
        body: { createdBy: USER_A, isDeleted: true, deletedBy: USER_A, order: -999 },
      }),
      makeRes()
    );

    const applied = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.createdBy).toBe(USER_A);
    expect(applied.isDeleted).toBe(true);
    expect(applied.deletedBy).toBe(USER_A);
    expect(applied.order).toBe(-999);
  });

  // The same unfiltered spread lets a caller rewrite projectId, moving a task
  // out of the project that authorised the edit and into another one.
  it('lets a member move a task into a different project by naming projectId', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(makeTaskDoc());
    mockTaskUpdateReturns(makeTaskDoc());

    await updateTask(
      makeReq({ params: { id: TASK_A }, body: { projectId: PROJECT_B } }),
      makeRes()
    );

    const applied = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.projectId).toBe(PROJECT_B);
  });

  it('writes arbitrary fields on the standalone-task path too', async () => {
    (Task.findOne as jest.Mock).mockResolvedValue(
      makeTaskDoc({ projectId: null, createdBy: USER_A })
    );
    mockTaskUpdateReturns(makeTaskDoc({ projectId: null }));

    await updateTask(
      makeReq({ params: { id: TASK_A }, body: { createdBy: USER_B, isDeleted: true } }),
      makeRes()
    );

    const applied = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.createdBy).toBe(USER_B);
    expect(applied.isDeleted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteTask
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteTask', () => {
  it('returns 404 for a nonexistent or already soft-deleted task', async () => {
    mockTaskFindOne(null);
    const res = makeRes();

    await deleteTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Task.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('soft-deletes a project task, recording who deleted it and when', async () => {
    mockTaskFindOne(makeTaskDoc());
    (Task.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
    const res = makeRes();

    await deleteTask(makeReq({ params: { id: TASK_A } }), res);

    const [targetId, update] = (Task.findByIdAndUpdate as jest.Mock).mock.calls[0];
    expect(targetId).toBe(TASK_A);
    expect(update.isDeleted).toBe(true);
    expect(update.deletedBy).toBe(USER_A);
    expect(update.deletedAt).toBeInstanceOf(Date);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('hard-deletes a standalone task instead of soft-deleting it', async () => {
    mockTaskFindOne(makeTaskDoc({ projectId: null }));
    (Task.findByIdAndDelete as jest.Mock).mockResolvedValue({});
    const res = makeRes();

    await deleteTask(makeReq({ params: { id: TASK_A } }), res);

    expect(Task.findByIdAndDelete).toHaveBeenCalledWith(TASK_A);
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Project.findById).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('deletes only the task named in the route, ignoring ids in the body', async () => {
    mockTaskFindOne(makeTaskDoc());
    (Task.findByIdAndUpdate as jest.Mock).mockResolvedValue({});

    await deleteTask(makeReq({ params: { id: TASK_A }, body: { id: TASK_B, _id: TASK_B } }), makeRes());

    expect((Task.findByIdAndUpdate as jest.Mock).mock.calls[0][0]).toBe(TASK_A);
  });

  it('returns 404 without deleting when the task’s project is missing', async () => {
    mockTaskFindOne(makeTaskDoc());
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Task.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('audits the deletion against the task’s own project', async () => {
    mockTaskFindOne(makeTaskDoc());
    (Task.findByIdAndUpdate as jest.Mock).mockResolvedValue({});

    await deleteTask(makeReq({ params: { id: TASK_A } }), makeRes());

    expect(AuditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_A,
        userId: USER_A,
        action: 'task_deleted',
        entityId: TASK_A,
      })
    );
  });

  it('returns 500 without leaking internals when the delete fails', async () => {
    mockTaskFindOne(makeTaskDoc());
    (Task.findByIdAndUpdate as jest.Mock).mockRejectedValue(new Error('mongo down on shard-7'));
    const res = makeRes();

    await deleteTask(makeReq({ params: { id: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to delete task' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('shard-7');
  });
});
