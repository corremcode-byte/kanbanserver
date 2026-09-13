/**
 * Task reorder / move data integrity.
 *
 * POST /api/tasks/reorder carries NO permission middleware — the route comment
 * says the check is "handled in controller since it's a batch operation", so the
 * controller's own authorization is the only gate. These tests exercise that
 * gate and the scoping of the batch write it performs.
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

import { Task, Project } from '../../models';
import { reorderTasks } from '../tasksController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const OWNER_B = '507f1f77bcf86cd799439033';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';
const TASK_IN_A = '707f1f77bcf86cd7994390c1';
const TASK_IN_B = '707f1f77bcf86cd7994390c2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body: any, user: any = { _id: USER_A, email: 'a@example.com' }) {
  return { user, body, params: {}, query: {} } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** Project A: owned by OWNER_B, USER_A is a member. */
function makeProjectA(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: OWNER_B,
    owners: [OWNER_B] as any[],
    members: [USER_A, USER_B] as any[],
    managers: [] as any[],
    ...overrides,
  };
}

/** Project B: USER_A has no relationship with it. */
function makeProjectB(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_B,
    ownerId: OWNER_B,
    owners: [OWNER_B] as any[],
    members: [USER_B] as any[],
    managers: [] as any[],
    ...overrides,
  };
}

const VALID_TASKS = [{ id: TASK_IN_A, status: 'in-progress', order: 0 }];

beforeEach(() => {
  (Project.findById as jest.Mock).mockResolvedValue(makeProjectA());
  (Task.reorderTasks as jest.Mock).mockResolvedValue(undefined);
});

describe('reorderTasks — request validation', () => {
  it('requires a projectId', async () => {
    const res = makeRes();

    await reorderTasks(makeReq({ tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Project ID is required');
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('rejects a missing, non-array or empty tasks list', async () => {
    const invalidValues: any[] = [undefined, 'not-an-array', [], null];

    for (const tasks of invalidValues) {
      const res = makeRes();

      await reorderTasks(makeReq({ projectId: PROJECT_A, tasks }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Tasks array is required');
    }
    expect(Task.reorderTasks).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
    expect(Task.reorderTasks).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking internals when the batch write fails', async () => {
    (Task.reorderTasks as jest.Mock).mockRejectedValue(new Error('txn aborted on shard-4'));
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res)).toEqual({ success: false, message: 'Failed to reorder tasks' });
    expect(JSON.stringify(payloadOf(res))).not.toContain('shard-4');
  });
});

describe('reorderTasks — project access', () => {
  it('allows a project member to reorder within their project', async () => {
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(Task.reorderTasks).toHaveBeenCalledTimes(1);
  });

  it('allows the project owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectA({ ownerId: USER_A, members: [] }));
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a project manager', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ members: [USER_B], managers: [USER_A] })
    );
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('denies a user with no relationship to the project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_B, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this project');
    expect(Task.reorderTasks).not.toHaveBeenCalled();
  });

  it('denies a co-owner who is only in owners[] — that array is not consulted here', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectB({ owners: [OWNER_B, USER_A], coOwnerPermissions: { [USER_A]: 'edit' } })
    );
    const res = makeRes();

    await reorderTasks(makeReq({ projectId: PROJECT_B, tasks: VALID_TASKS }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('authorises against the body projectId, which is also what the write receives', async () => {
    await reorderTasks(makeReq({ projectId: PROJECT_A, tasks: VALID_TASKS }), makeRes());

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
    expect((Task.reorderTasks as jest.Mock).mock.calls[0][0]).toBe(PROJECT_A);
  });

  it('maps each entry to _id/status/order for the batch write', async () => {
    await reorderTasks(
      makeReq({
        projectId: PROJECT_A,
        tasks: [{ id: TASK_IN_A, status: 'done', order: 3, title: 'ignored' }],
      }),
      makeRes()
    );

    expect((Task.reorderTasks as jest.Mock).mock.calls[0][1]).toEqual([
      { _id: TASK_IN_A, status: 'done', order: 3 },
    ]);
  });
});

describe('reorderTasks — cross-project mutation (documented, not fixed)', () => {
  // SECURITY FINDING (documented, not fixed): the controller authorises the
  // caller against req.body.projectId, but never verifies that the task ids in
  // req.body.tasks actually belong to that project. Task.reorderTasks then
  // ignores its projectId argument entirely and calls
  // findByIdAndUpdate(task._id, ...) unscoped (src/models/Task.ts:259-292).
  //
  // Net effect: any member of any project can rewrite the status, listId and
  // order of arbitrary tasks in projects they have no access to, by naming
  // their own project as projectId and a foreign task id in the batch.
  it('accepts a foreign task id in a batch authorised against the caller’s own project', async () => {
    const res = makeRes();

    await reorderTasks(
      makeReq({
        projectId: PROJECT_A, // caller is a member here — authorization passes
        tasks: [{ id: TASK_IN_B, status: 'completed', order: 0 }], // task lives in PROJECT_B
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(Task.reorderTasks).toHaveBeenCalledWith(PROJECT_A, [
      { _id: TASK_IN_B, status: 'completed', order: 0 },
    ]);
  });

  it('never loads the tasks it is about to mutate, so ownership is never verified', async () => {
    await reorderTasks(
      makeReq({ projectId: PROJECT_A, tasks: [{ id: TASK_IN_B, status: 'todo', order: 1 }] }),
      makeRes()
    );

    // No per-task lookup happens anywhere in the path.
    expect(Task.findById).not.toHaveBeenCalled();
    expect(Task.findOne).not.toHaveBeenCalled();
    expect(Task.find).not.toHaveBeenCalled();
  });

  it('passes a mixed batch of in-project and foreign task ids through unfiltered', async () => {
    const res = makeRes();

    await reorderTasks(
      makeReq({
        projectId: PROJECT_A,
        tasks: [
          { id: TASK_IN_A, status: 'todo', order: 0 },
          { id: TASK_IN_B, status: 'todo', order: 1 },
        ],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const written = (Task.reorderTasks as jest.Mock).mock.calls[0][1];
    expect(written.map((t: any) => t._id)).toEqual([TASK_IN_A, TASK_IN_B]);
  });

  it('accepts duplicate task ids in one batch without deduplicating', async () => {
    await reorderTasks(
      makeReq({
        projectId: PROJECT_A,
        tasks: [
          { id: TASK_IN_A, status: 'todo', order: 0 },
          { id: TASK_IN_A, status: 'completed', order: 5 },
        ],
      }),
      makeRes()
    );

    const written = (Task.reorderTasks as jest.Mock).mock.calls[0][1];
    expect(written).toHaveLength(2);
    // Last write wins in the model loop — the final state is 'completed'.
    expect(written[1]).toEqual({ _id: TASK_IN_A, status: 'completed', order: 5 });
  });

  it('forwards malformed task ids and undefined fields to the batch write unvalidated', async () => {
    const res = makeRes();

    await reorderTasks(
      makeReq({ projectId: PROJECT_A, tasks: [{ id: 'not-an-objectid' }] }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect((Task.reorderTasks as jest.Mock).mock.calls[0][1]).toEqual([
      { _id: 'not-an-objectid', status: undefined, order: undefined },
    ]);
  });
});

describe('Task.reorderTasks static — projectId is not used for scoping', () => {
  // Locks in the root cause behind the controller finding above: the model's
  // signature takes a projectId but the implementation never references it.
  it('declares a projectId parameter that the implementation ignores', () => {
    const source = jest
      .requireActual('fs')
      .readFileSync(require.resolve('../../models/Task'), 'utf8') as string;

    const body = source.slice(source.indexOf('TaskSchema.statics.reorderTasks'));
    const implementation = body.slice(0, body.indexOf('const Task = mongoose.model'));

    // The update is keyed on the task id alone …
    expect(implementation).toContain('findByIdAndUpdate');
    // … and projectId appears only in the signature, never in a query filter.
    const projectIdMentions = implementation.match(/projectId/g) || [];
    expect(projectIdMentions).toHaveLength(1);
  });
});
