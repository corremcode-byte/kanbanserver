/**
 * Task time logs: project access, assignee restriction and log ownership.
 *
 * Actor/target model: USER_A is the caller and a member of PROJECT_A.
 * PROJECT_B/TASK_B belong to an unrelated project; LOG_B belongs to USER_B.
 */

jest.mock('../../models', () => ({
  Task: { findById: jest.fn() },
  Project: { findById: jest.fn() },
  TaskTimeLog: Object.assign(jest.fn(), {
    findById: jest.fn(),
    findByIdAndDelete: jest.fn(),
    findByTask: jest.fn(),
    findByProject: jest.fn(),
    findByUser: jest.fn(),
    getTotalTimeByTask: jest.fn(),
    getTotalTimeByUser: jest.fn(),
  }),
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { Task, Project, TaskTimeLog } from '../../models';
import {
  logTime,
  getTaskTimeLogs,
  getProjectTimeLogs,
  getUserTimeLogs,
  updateTimeLog,
  deleteTimeLog,
} from '../timeTrackingController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const OWNER_B = '507f1f77bcf86cd799439033';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';
const TASK_A = '707f1f77bcf86cd7994390c1';
const LOG_B = '807f1f77bcf86cd7994390d2';

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
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** PROJECT_A: owned by OWNER_B, USER_A is a member. */
function makeProjectA(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: { toString: () => OWNER_B },
    members: [{ toString: () => USER_A }],
    managers: [] as any[],
    ...overrides,
  };
}

/** PROJECT_B: USER_A has no relationship with it. */
function makeProjectB() {
  return {
    _id: PROJECT_B,
    ownerId: { toString: () => OWNER_B },
    members: [{ toString: () => USER_B }],
    managers: [] as any[],
  };
}

function makeTask(overrides: Record<string, any> = {}) {
  return {
    _id: TASK_A,
    projectId: PROJECT_A,
    assignees: [{ toString: () => USER_A }],
    assignedTo: undefined as any,
    ...overrides,
  };
}

function makeLog(overrides: Record<string, any> = {}) {
  return {
    _id: LOG_B,
    userId: { toString: () => USER_B },
    timeSpent: 60,
    description: 'work',
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  (Task.findById as jest.Mock).mockResolvedValue(makeTask());
  (Project.findById as jest.Mock).mockResolvedValue(makeProjectA());
  (TaskTimeLog as unknown as jest.Mock).mockImplementation(function (this: any, fields: any) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
    this.populate = jest.fn().mockResolvedValue(undefined);
    return this;
  });
  (TaskTimeLog.findByTask as jest.Mock).mockResolvedValue([]);
  (TaskTimeLog.findByProject as jest.Mock).mockResolvedValue([]);
  (TaskTimeLog.findByUser as jest.Mock).mockResolvedValue([]);
  (TaskTimeLog.getTotalTimeByTask as jest.Mock).mockResolvedValue(0);
  (TaskTimeLog.getTotalTimeByUser as jest.Mock).mockResolvedValue(0);
});

describe('logTime — validation', () => {
  it('requires a task id and a time value', async () => {
    for (const body of [{}, { taskId: TASK_A }, { timeSpent: 30 }]) {
      const res = makeRes();
      await logTime(makeReq({ body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Task ID and time spent are required');
    }
    expect(Task.findById).not.toHaveBeenCalled();
  });

  it('rejects a negative duration', async () => {
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: -5 } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Time spent must be a positive number');
  });

  it('accepts a zero-minute entry', async () => {
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 0 } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Task not found');
  });

  it('returns 404 when the task’s project is missing', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
  });

  it('defaults loggedAt to now when none is supplied', async () => {
    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), makeRes());

    const constructed = (TaskTimeLog as unknown as jest.Mock).mock.instances[0] as any;
    expect(constructed.loggedAt).toBeInstanceOf(Date);
  });

  it('honours an explicit loggedAt timestamp', async () => {
    await logTime(
      makeReq({ body: { taskId: TASK_A, timeSpent: 30, loggedAt: '2026-01-01T00:00:00.000Z' } }),
      makeRes()
    );

    const constructed = (TaskTimeLog as unknown as jest.Mock).mock.instances[0] as any;
    expect(constructed.loggedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('logTime — access control', () => {
  it('denies a user with no relationship to the project', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this task');
    expect(TaskTimeLog as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('restricts a plain member to tasks they are assigned to', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [{ toString: () => USER_B }] })
    );
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You can only log time for tasks assigned to you');
  });

  it('allows a member assigned through the legacy assignedTo field', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [], assignedTo: { toString: () => USER_A } })
    );
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('lets the project owner log time on any task, assigned or not', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ ownerId: { toString: () => USER_A }, members: [] })
    );
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [{ toString: () => USER_B }] })
    );
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('lets a project manager log time on any task', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ members: [], managers: [{ toString: () => USER_A }] })
    );
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [{ toString: () => USER_B }] })
    );
    const res = makeRes();

    await logTime(makeReq({ body: { taskId: TASK_A, timeSpent: 30 } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('attributes the log to the authenticated user, ignoring a body userId', async () => {
    await logTime(
      makeReq({ body: { taskId: TASK_A, timeSpent: 30, userId: USER_B } }),
      makeRes()
    );

    const constructed = (TaskTimeLog as unknown as jest.Mock).mock.instances[0] as any;
    expect(constructed.userId).toBe(USER_A);
  });

  it('derives projectId from the task rather than the request body', async () => {
    await logTime(
      makeReq({ body: { taskId: TASK_A, timeSpent: 30, projectId: PROJECT_B } }),
      makeRes()
    );

    const constructed = (TaskTimeLog as unknown as jest.Mock).mock.instances[0] as any;
    expect(constructed.projectId).toBe(PROJECT_A);
  });
});

describe('getTaskTimeLogs and getProjectTimeLogs — project isolation', () => {
  it('denies task logs to a non-member', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await getTaskTimeLogs(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskTimeLog.findByTask).not.toHaveBeenCalled();
  });

  it('returns task logs and a total for a member', async () => {
    (TaskTimeLog.getTotalTimeByTask as jest.Mock).mockResolvedValue(120);
    const res = makeRes();

    await getTaskTimeLogs(makeReq({ params: { taskId: TASK_A } }), res);

    expect(payloadOf(res).data.totalTime).toBe(120);
    expect(TaskTimeLog.findByTask).toHaveBeenCalledWith(TASK_A);
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getTaskTimeLogs(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies project logs to a non-member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await getProjectTimeLogs(makeReq({ params: { projectId: PROJECT_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this project');
    expect(TaskTimeLog.findByProject).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getProjectTimeLogs(makeReq({ params: { projectId: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('passes an optional date range through to the query', async () => {
    await getProjectTimeLogs(
      makeReq({
        params: { projectId: PROJECT_A },
        query: { startDate: '2026-01-01', endDate: '2026-02-01' },
      }),
      makeRes()
    );

    const [projectId, start, end] = (TaskTimeLog.findByProject as jest.Mock).mock.calls[0];
    expect(projectId).toBe(PROJECT_A);
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
  });

  it('omits the range when no dates are supplied', async () => {
    await getProjectTimeLogs(makeReq({ params: { projectId: PROJECT_A } }), makeRes());

    const [, start, end] = (TaskTimeLog.findByProject as jest.Mock).mock.calls[0];
    expect(start).toBeUndefined();
    expect(end).toBeUndefined();
  });
});

describe('getUserTimeLogs — caller scoping', () => {
  it('queries only the authenticated user’s logs', async () => {
    await getUserTimeLogs(makeReq(), makeRes());

    expect(TaskTimeLog.findByUser).toHaveBeenCalledWith(USER_A, undefined, undefined);
  });

  it('cannot be redirected by a userId in the query string', async () => {
    await getUserTimeLogs(makeReq({ query: { userId: USER_B } }), makeRes());

    expect((TaskTimeLog.findByUser as jest.Mock).mock.calls[0][0]).toBe(USER_A);
  });

  it('returns logs alongside the caller’s total', async () => {
    (TaskTimeLog.getTotalTimeByUser as jest.Mock).mockResolvedValue(480);
    const res = makeRes();

    await getUserTimeLogs(makeReq(), res);

    expect(payloadOf(res).data.totalTime).toBe(480);
  });

  it('returns 500 when the query throws', async () => {
    (TaskTimeLog.findByUser as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await getUserTimeLogs(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateTimeLog and deleteTimeLog — log ownership', () => {
  it('returns 404 for a nonexistent log', async () => {
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateTimeLog(makeReq({ params: { timeLogId: LOG_B }, body: { timeSpent: 10 } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies updating another user’s log', async () => {
    const log = makeLog();
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(log);
    const res = makeRes();

    await updateTimeLog(makeReq({ params: { timeLogId: LOG_B }, body: { timeSpent: 10 } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You can only update your own time logs');
    expect(log.save).not.toHaveBeenCalled();
  });

  it('rejects a negative duration on update', async () => {
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(
      makeLog({ userId: { toString: () => USER_A } })
    );
    const res = makeRes();

    await updateTimeLog(makeReq({ params: { timeLogId: LOG_B }, body: { timeSpent: -1 } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('updates the caller’s own log', async () => {
    const log = makeLog({ userId: { toString: () => USER_A } });
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(log);
    const res = makeRes();

    await updateTimeLog(
      makeReq({ params: { timeLogId: LOG_B }, body: { timeSpent: 90, description: '  revised  ' } }),
      res
    );

    expect(log.timeSpent).toBe(90);
    expect(log.description).toBe('revised');
    expect(log.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('leaves untouched fields alone on a partial update', async () => {
    const log = makeLog({ userId: { toString: () => USER_A }, timeSpent: 60, description: 'orig' });
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(log);

    await updateTimeLog(makeReq({ params: { timeLogId: LOG_B }, body: {} }), makeRes());

    expect(log.timeSpent).toBe(60);
    expect(log.description).toBe('orig');
  });

  it('denies deleting another user’s log', async () => {
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(makeLog());
    const res = makeRes();

    await deleteTimeLog(makeReq({ params: { timeLogId: LOG_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskTimeLog.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('deletes the caller’s own log', async () => {
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(
      makeLog({ userId: { toString: () => USER_A } })
    );
    const res = makeRes();

    await deleteTimeLog(makeReq({ params: { timeLogId: LOG_B } }), res);

    expect(TaskTimeLog.findByIdAndDelete).toHaveBeenCalledWith(LOG_B);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // Ownership is the only gate — being the project owner does not help.
  it('returns 404 for a nonexistent log on delete', async () => {
    (TaskTimeLog.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteTimeLog(makeReq({ params: { timeLogId: LOG_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(TaskTimeLog.findByIdAndDelete).not.toHaveBeenCalled();
  });
});
