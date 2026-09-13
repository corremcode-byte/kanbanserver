/**
 * Task message / comment channel — a separate mechanism from chat groups, with
 * its own authorization helper (checkTaskAccess).
 *
 * Actor/target model: USER_A is the authenticated caller and a member of
 * PROJECT_A. PROJECT_B and TASK_B belong to an unrelated project.
 */

jest.mock('../../models/TaskMessage', () => {
  const TaskMessage: any = { find: jest.fn(), findById: jest.fn(), create: jest.fn() };
  return { __esModule: true, default: TaskMessage, TaskMessage };
});

jest.mock('../../models/Task', () => {
  const Task: any = { findById: jest.fn() };
  return { __esModule: true, default: Task, Task };
});

jest.mock('../../models/Project', () => {
  const Project: any = { findById: jest.fn() };
  return { __esModule: true, default: Project, Project };
});

jest.mock('../../models/AuditLog', () => ({
  AuditLog: { logAction: jest.fn(), logSystemEvent: jest.fn() },
}));

jest.mock('../../socket', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

jest.mock('../../socket/socketHandlers', () => ({
  broadcastToUser: jest.fn(),
  broadcastToProject: jest.fn(),
}));

jest.mock('../notificationController', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/fieldEncryption', () => ({
  decryptField: jest.fn((v: string) => v),
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import TaskMessage from '../../models/TaskMessage';
import Task from '../../models/Task';
import Project from '../../models/Project';
import { AuditLog } from '../../models/AuditLog';
import { broadcastToUser, broadcastToProject } from '../../socket/socketHandlers';
import { createNotification } from '../notificationController';
import { getMessages, sendMessage, deleteMessage } from '../taskMessagesController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const OWNER_B = '507f1f77bcf86cd799439033';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';
const TASK_A = '707f1f77bcf86cd7994390c1';
const TASK_B = '707f1f77bcf86cd7994390c2';
const MESSAGE_B = '807f1f77bcf86cd7994390d2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A', role: 'member' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeTask(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => TASK_A },
    title: 'Task A',
    projectId: PROJECT_A,
    createdBy: USER_B,
    assignedBy: USER_B,
    assignedTo: undefined as any,
    assignees: [] as any[],
    ...overrides,
  };
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

/** TaskMessage.find(...).populate().populate().sort() */
function mockMessageFind(rows: any[]) {
  const chain: any = { populate: jest.fn(() => chain), sort: jest.fn(() => chain) };
  chain.then = (resolve: any) => Promise.resolve(rows).then(resolve);
  (TaskMessage.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

function mockCreatedMessage() {
  const msg: any = {
    _id: { toString: () => 'new-msg' },
    populate: jest.fn(),
    toJSON: () => ({ id: 'new-msg' }),
  };
  msg.populate.mockResolvedValue(msg);
  (TaskMessage.create as jest.Mock).mockResolvedValue(msg);
  return msg;
}

beforeEach(() => {
  (Task.findById as jest.Mock).mockResolvedValue(makeTask());
  (Project.findById as jest.Mock).mockResolvedValue(makeProjectA());
  (AuditLog.logAction as jest.Mock).mockResolvedValue(undefined);
  mockMessageFind([]);
  mockCreatedMessage();
});

describe('getMessages — task access', () => {
  it('returns an empty list for a malformed task id rather than erroring', async () => {
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: 'not-an-objectid' } }), res);

    expect(payloadOf(res).data).toEqual([]);
    expect(Task.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(TaskMessage.find).not.toHaveBeenCalled();
  });

  it('allows a project member to read a task’s messages', async () => {
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(TaskMessage.find).toHaveBeenCalledWith({ taskId: TASK_A });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('denies a user with no relationship to the task’s project', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied');
    expect(TaskMessage.find).not.toHaveBeenCalled();
  });

  it('denies access when the task’s project no longer exists', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows the project owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ ownerId: { toString: () => USER_A }, members: [] })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a project manager who is not a member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ members: [], managers: [{ toString: () => USER_A }] })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('derives the project from the stored task, ignoring a body projectId', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await getMessages(
      makeReq({ params: { taskId: TASK_B }, body: { projectId: PROJECT_A } }),
      res
    );

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_B);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 500 when the message query throws', async () => {
    (TaskMessage.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getMessages — standalone tasks', () => {
  it('allows the creator of a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_A })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('allows an assignee of a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignees: [USER_A] })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows the assigner of a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignedBy: USER_A })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('denies an unrelated user on a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_B, assignedBy: USER_B })
    );
    const res = makeRes();

    await getMessages(makeReq({ params: { taskId: TASK_A } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('sendMessage — validation and access', () => {
  it('requires non-empty text', async () => {
    for (const text of [undefined, '', '   ']) {
      const res = makeRes();
      await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Message text is required');
    }
    expect(Task.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed task id', async () => {
    const res = makeRes();

    await sendMessage(makeReq({ params: { taskId: 'bad-id' }, body: { text: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(TaskMessage.create).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies posting to a task in another project', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ projectId: PROJECT_B }));
    (Project.findById as jest.Mock).mockResolvedValue(makeProjectB());
    const res = makeRes();

    await sendMessage(makeReq({ params: { taskId: TASK_B }, body: { text: 'intrusion' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskMessage.create).not.toHaveBeenCalled();
  });

  it('creates the message attributed to the authenticated sender', async () => {
    await sendMessage(
      makeReq({ params: { taskId: TASK_A }, body: { text: '  hello  ', sentBy: USER_B } }),
      makeRes()
    );

    const created = (TaskMessage.create as jest.Mock).mock.calls[0][0];
    expect(created.sentBy).toBe(USER_A);
    expect(created.text).toBe('hello');
    expect(created.taskId).toBe(TASK_A);
  });

  it('filters mentions down to valid object ids', async () => {
    await sendMessage(
      makeReq({
        params: { taskId: TASK_A },
        body: { text: 'hi', mentions: [USER_B, 'not-an-id', ''] },
      }),
      makeRes()
    );

    expect((TaskMessage.create as jest.Mock).mock.calls[0][0].mentions).toEqual([USER_B]);
  });

  it('tolerates a non-array mentions value', async () => {
    await sendMessage(
      makeReq({ params: { taskId: TASK_A }, body: { text: 'hi', mentions: 'nope' } }),
      makeRes()
    );

    expect((TaskMessage.create as jest.Mock).mock.calls[0][0].mentions).toEqual([]);
  });

  it('writes an audit entry scoped to the task’s project', async () => {
    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), makeRes());

    expect(AuditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_A,
        userId: USER_A,
        action: 'task_message_sent',
        entityType: 'message',
      })
    );
  });

  it('still sends the message when audit logging fails', async () => {
    (AuditLog.logAction as jest.Mock).mockRejectedValue(new Error('audit offline'));
    const res = makeRes();

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('broadcasts to each participant’s personal room and to the project room', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [USER_B], createdBy: USER_B })
    );

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), makeRes());

    const recipients = (broadcastToUser as jest.Mock).mock.calls.map((c) => c[1]);
    expect(recipients).toEqual(expect.arrayContaining([USER_A, USER_B]));
    expect(broadcastToProject).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_A,
      'task:message',
      expect.anything()
    );
  });

  it('does not broadcast to a project room for a standalone task', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ projectId: null, createdBy: USER_A })
    );

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), makeRes());

    expect(broadcastToProject).not.toHaveBeenCalled();
    expect(broadcastToUser).toHaveBeenCalled();
  });

  it('notifies the other participants but never the sender', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ assignees: [USER_B], createdBy: USER_A })
    );

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), makeRes());

    const notified = (createNotification as jest.Mock).mock.calls.map((c) => c[0].userId);
    expect(notified).toContain(USER_B);
    expect(notified).not.toContain(USER_A);
  });

  it('truncates a long message in the notification preview', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(makeTask({ assignees: [USER_B] }));

    await sendMessage(
      makeReq({ params: { taskId: TASK_A }, body: { text: 'x'.repeat(200) } }),
      makeRes()
    );

    const preview = (createNotification as jest.Mock).mock.calls[0][0].message;
    expect(preview).toContain('…');
    expect(preview.length).toBeLessThan(200);
  });

  it('sends no notifications when the sender is the only participant', async () => {
    (Task.findById as jest.Mock).mockResolvedValue(
      makeTask({ createdBy: USER_A, assignedBy: USER_A, assignees: [] })
    );

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), makeRes());

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('returns 500 when message creation fails', async () => {
    (TaskMessage.create as jest.Mock).mockRejectedValue(new Error('write failed'));
    const res = makeRes();

    await sendMessage(makeReq({ params: { taskId: TASK_A }, body: { text: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteMessage — sender ownership', () => {
  it('returns 404 for a nonexistent message', async () => {
    (TaskMessage.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies deleting another user’s message', async () => {
    const msg: any = {
      sentBy: { toString: () => USER_B },
      deleteOne: jest.fn().mockResolvedValue(undefined),
    };
    (TaskMessage.findById as jest.Mock).mockResolvedValue(msg);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only the sender can delete this message');
    expect(msg.deleteOne).not.toHaveBeenCalled();
  });

  it('allows the sender to delete their own message', async () => {
    const msg: any = {
      sentBy: { toString: () => USER_A },
      deleteOne: jest.fn().mockResolvedValue(undefined),
    };
    (TaskMessage.findById as jest.Mock).mockResolvedValue(msg);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(msg.deleteOne).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // Deletion is sender-only: unlike the chat-group channel there is no
  // group-creator or project-owner override.
  it('denies even the project owner when they are not the sender', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProjectA({ ownerId: { toString: () => USER_A } })
    );
    const msg: any = {
      sentBy: { toString: () => USER_B },
      deleteOne: jest.fn().mockResolvedValue(undefined),
    };
    (TaskMessage.findById as jest.Mock).mockResolvedValue(msg);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 500 when the delete throws', async () => {
    (TaskMessage.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
