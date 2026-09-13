jest.mock('../../models', () => ({
  ProjectPermission: { findOne: jest.fn() },
  Project: { findById: jest.fn() },
  Task: { findById: jest.fn() },
}));

jest.mock('../../models/User', () => ({
  User: { findById: jest.fn() },
}));

import { ProjectPermission, Project, Task } from '../../models';
import { User } from '../../models/User';
import { checkCanEditTask, checkCanDeleteTask, checkTaskAccess } from '../permissions';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const TASK_A = '707f1f77bcf86cd7994390c3';

let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return { user: { _id: USER_A }, params: { id: TASK_A }, body: {}, ...overrides } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** A task in PROJECT_A created by and assigned to USER_B. */
function makeTask(overrides: Record<string, any> = {}) {
  return {
    _id: TASK_A,
    projectId: PROJECT_A,
    createdBy: USER_B,
    assignedBy: USER_B,
    assignedTo: USER_B,
    assignees: [] as any[],
    ...overrides,
  };
}

function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: USER_B,
    owners: [] as any[],
    members: [] as any[],
    managers: [] as any[],
    coOwnerPermissions: undefined as any,
    ...overrides,
  };
}

function makePermissionRecord(permissions: Record<string, any> = {}) {
  return {
    permissions: {
      canCreateTasks: false,
      canEditTasks: false,
      canDeleteTasks: false,
      canAssignTasks: false,
      ...permissions,
    },
  };
}

async function runEdit(req: any) {
  const res = makeRes();
  const next = jest.fn();
  await checkCanEditTask(req, res, next);
  return { res, next };
}

async function runDelete(req: any) {
  const res = makeRes();
  const next = jest.fn();
  await checkCanDeleteTask(req, res, next);
  return { res, next };
}

beforeEach(() => {
  (Task.findById as jest.Mock).mockResolvedValue(makeTask());
  (Project.findById as jest.Mock).mockResolvedValue(makeProject());
  (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
  (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
});

describe('checkCanEditTask — request validation', () => {
  it('rejects an unauthenticated request with 400', async () => {
    const { res, next } = await runEdit(makeReq({ user: undefined }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid request');
  });

  it('rejects a request with no task id in the route', async () => {
    const { res, next } = await runEdit(makeReq({ params: {} }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Task.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Task not found');
  });

  it('returns 404 when the task references a project that no longer exists', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
  });

  it('fails closed with 500 when the task lookup throws', async () => {
    (Task.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Permission check failed');
  });

  it('authorises the task named in the route, ignoring a body-supplied task id', async () => {
    await runEdit(makeReq({ body: { id: 'other-task', taskId: 'other-task' } }));

    expect(Task.findById).toHaveBeenCalledWith(TASK_A);
    expect(Task.findById).not.toHaveBeenCalledWith('other-task');
  });
});

describe('checkCanEditTask — standalone tasks (no project)', () => {
  it('allows the task creator', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_A, assignedBy: USER_B, assignedTo: USER_B })
    );

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a user listed in assignees', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignedBy: USER_B, assignedTo: USER_B, assignees: [USER_A] })
    );

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the user who assigned the task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignedBy: USER_A, assignedTo: USER_B })
    );

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a user holding global canEditTasks', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: null }));
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canEditTasks: true } });

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies an unrelated user with no global permission', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: null }));

    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to edit this task");
    expect(ProjectPermission.findOne).not.toHaveBeenCalled();
  });
});

describe('checkCanEditTask — project tasks', () => {
  it('allows the project main owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the task assignee who is otherwise unprivileged', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ assignees: [USER_A] }));

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the task creator even when assigned to someone else', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ createdBy: USER_A }));

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a user with global canEditTasks', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canEditTasks: true } });

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a project member whose permission record grants canEditTasks', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditTasks: true })
    );

    const { next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a project member whose record withholds canEditTasks', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditTasks: false })
    );

    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to edit tasks in this project");
  });

  it('denies a user with no relationship to the project at all', async () => {
    const { res, next } = await runEdit(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('scopes the permission lookup to the task’s own project', async () => {
    await runEdit(makeReq());

    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_A, userId: USER_A });
  });

  // FINDING (documented, not fixed): unlike checkPermission, the task
  // middleware grants on `isOwner || isInOwners` without ever reading
  // coOwnerPermissions. A co-owner explicitly restricted to 'view' can edit
  // every task in the project.
  it('lets a view-only co-owner edit any task — co-owner level is not checked', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );

    const { res, next } = await runEdit(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('exposes checkTaskAccess as the same middleware as checkCanEditTask', () => {
    expect(checkTaskAccess).toBe(checkCanEditTask);
  });
});

describe('checkCanDeleteTask', () => {
  it('rejects a request with no task id', async () => {
    const { res, next } = await runDelete(makeReq({ params: {} }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await runDelete(makeReq());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the creator of a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: null, createdBy: USER_A }));

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies the assignee of a standalone task — deletion is stricter than editing', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignees: [USER_A], assignedTo: USER_A })
    );

    const { res, next } = await runDelete(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to delete this task");
  });

  it('allows a standalone task deletion with global canDeleteTasks', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: null }));
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canDeleteTasks: true } });

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the project main owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a user with global canDeleteTasks', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canDeleteTasks: true } });

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies the assignee of a project task who lacks canDeleteTasks', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ assignees: [USER_A] }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditTasks: true, canDeleteTasks: false })
    );

    const { res, next } = await runDelete(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to delete tasks");
  });

  it('allows a project member whose record grants canDeleteTasks', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canDeleteTasks: true })
    );

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a user with no permission record for the project', async () => {
    const { res, next } = await runDelete(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('lets a view-only co-owner delete any task — co-owner level is not checked', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );

    const { next } = await runDelete(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 500 when the permission lookup throws', async () => {
    (ProjectPermission.findOne as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await runDelete(makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
