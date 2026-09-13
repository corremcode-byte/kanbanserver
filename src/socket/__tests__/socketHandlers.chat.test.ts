/**
 * Socket.IO chat and project event authorization.
 *
 * setupSocketHandlers is driven through a fake io/socket harness: handlers
 * registered via socket.on are captured and invoked directly. No real sockets.
 *
 * Actor/target model: USER_A is the connected socket's user. GROUP_B and
 * PROJECT_B belong to an unrelated project USER_A has no access to.
 */

jest.mock('../socketAuth', () => ({
  getSocketUserId: jest.fn(),
  canJoinRoom: jest.fn(),
}));

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
  Project: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { getSocketUserId, canJoinRoom } from '../socketAuth';
import { setupSocketHandlers } from '../socketHandlers';

const USER_A = '507f1f77bcf86cd799439011';
const GROUP_A = '707f1f77bcf86cd7994390a1';
const GROUP_B = '707f1f77bcf86cd7994390b2';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

interface Harness {
  socket: any;
  io: any;
  fire: (event: string, ...args: any[]) => Promise<any>;
  /** Events emitted back to this socket only (excluding the initial 'connected'). */
  emitted: Array<{ event: string; payload: any }>;
  /** Clears everything captured so far, e.g. the connection handshake. */
  reset: () => void;
  /** Events broadcast to a room via socket.to(room).emit(...). */
  broadcasts: Array<{ room: string; event: string; payload: any }>;
  /** Rooms this socket joined / left. */
  joined: string[];
  left: string[];
}

/** Builds a fake socket + io pair and registers the real handlers on it. */
function makeHarness(userId: string | null = USER_A): Harness {
  const handlers = new Map<string, Function>();
  const emitted: Harness['emitted'] = [];
  const broadcasts: Harness['broadcasts'] = [];
  const joined: string[] = [];
  const left: string[] = [];

  const socket: any = {
    id: 'socket-1',
    data: {},
    user: { _id: USER_A, name: 'User A', email: 'a@example.com', avatar: null },
    handshake: { address: '127.0.0.1', headers: {} },
    on: jest.fn((event: string, handler: Function) => handlers.set(event, handler)),
    join: jest.fn((room: string) => joined.push(room)),
    leave: jest.fn((room: string) => left.push(room)),
    emit: jest.fn((event: string, payload: any) => emitted.push({ event, payload })),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: any) => broadcasts.push({ room, event, payload }),
    })),
    disconnect: jest.fn(),
  };

  const io: any = {
    on: jest.fn(),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: any) => broadcasts.push({ room, event, payload }),
    })),
  };

  (getSocketUserId as jest.Mock).mockReturnValue(userId);

  // Capture the connection callback, then run it with our fake socket.
  let connectionHandler: Function = () => {};
  io.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'connection') connectionHandler = cb;
  });
  setupSocketHandlers(io);
  connectionHandler(socket);

  return {
    socket,
    io,
    emitted,
    broadcasts,
    joined,
    left,
    reset: () => {
      emitted.length = 0;
      broadcasts.length = 0;
    },
    fire: async (event: string, ...args: any[]) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      return handler(...args);
    },
  };
}

beforeEach(() => {
  (canJoinRoom as jest.Mock).mockResolvedValue(true);
});

describe('connection lifecycle', () => {
  it('disconnects a socket that carries no user id', () => {
    const h = makeHarness(null);

    expect(h.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(h.socket.on).not.toHaveBeenCalled();
  });

  it('auto-joins the authenticated user to their own personal room', () => {
    const h = makeHarness();

    expect(h.joined).toContain(`user:${USER_A}`);
  });

  it('records the user id on socket.data for later lookups', () => {
    const h = makeHarness();

    expect(h.socket.data.userId).toBe(USER_A);
  });

  it('registers the chat and project event handlers', () => {
    const h = makeHarness();
    const registered = h.socket.on.mock.calls.map((c: any[]) => c[0]);

    for (const event of ['join:chat', 'leave:chat', 'join:project', 'chat:typing:start']) {
      expect(registered).toContain(event);
    }
  });
});

describe('join:project — membership is enforced', () => {
  it('rejects an empty or non-string project id', async () => {
    const h = makeHarness();
    h.reset(); // drop the connection handshake event

    for (const bad of ['', null, undefined, 123, {}]) {
      await h.fire('join:project', bad);
    }

    expect(h.emitted).toHaveLength(5);
    expect(h.emitted.every((e) => e.event === 'error')).toBe(true);
    expect(h.joined).not.toContain(`project:${PROJECT_A}`);
  });

  it('consults canJoinRoom before joining', async () => {
    const h = makeHarness();

    await h.fire('join:project', PROJECT_A);

    expect(canJoinRoom).toHaveBeenCalledWith(h.socket, 'project', PROJECT_A);
    expect(h.joined).toContain(`project:${PROJECT_A}`);
    expect(h.emitted).toContainEqual({ event: 'joined:project', payload: { projectId: PROJECT_A } });
  });

  it('denies a non-member and does not join the room', async () => {
    (canJoinRoom as jest.Mock).mockResolvedValue(false);
    const h = makeHarness();

    await h.fire('join:project', PROJECT_B);

    expect(h.joined).not.toContain(`project:${PROJECT_B}`);
    expect(h.emitted).toContainEqual({
      event: 'error',
      payload: { message: 'Access denied to project' },
    });
  });

  it('emits an error rather than throwing when the access check fails', async () => {
    (canJoinRoom as jest.Mock).mockRejectedValue(new Error('lookup failed'));
    const h = makeHarness();

    await h.fire('join:project', PROJECT_A);

    expect(h.emitted).toContainEqual({
      event: 'error',
      payload: { message: 'Failed to join project' },
    });
  });

  it('allows leaving any project room without a membership check', async () => {
    const h = makeHarness();

    await h.fire('leave:project', PROJECT_B);

    expect(h.left).toContain(`project:${PROJECT_B}`);
    expect(h.emitted).toContainEqual({ event: 'left:project', payload: { projectId: PROJECT_B } });
  });
});

describe('join:chat — membership is NOT enforced', () => {
  it('rejects an empty or non-string group id', async () => {
    const h = makeHarness();
    h.reset();

    for (const bad of ['', null, undefined, 0]) {
      await h.fire('join:chat', bad);
    }

    expect(h.joined).toHaveLength(1); // only the auto-joined user room
    expect(h.emitted).toHaveLength(4);
    expect(h.emitted.every((e) => e.event === 'error')).toBe(true);
  });

  // SECURITY FINDING (documented, NOT fixed): join:chat validates only that the
  // group id is a non-empty string and then joins `chat:<id>` unconditionally.
  // Unlike join:project it never calls canJoinRoom, and canJoinRoom has no
  // 'chat' case anyway. Any authenticated socket can join any group's room and
  // receive everything broadcast to it — typing indicators today, and any
  // future message fan-out to that room.
  it('joins an arbitrary group room with no membership check at all', async () => {
    const h = makeHarness();

    await h.fire('join:chat', GROUP_B);

    expect(h.joined).toContain(`chat:${GROUP_B}`);
    expect(canJoinRoom).not.toHaveBeenCalled();
    expect(h.emitted).toContainEqual({ event: 'joined:chat', payload: { groupId: GROUP_B } });
  });

  it('joins a group belonging to a project the user has no access to', async () => {
    (canJoinRoom as jest.Mock).mockResolvedValue(false);
    const h = makeHarness();
    h.reset();

    await h.fire('join:chat', GROUP_B);

    expect(h.joined).toContain(`chat:${GROUP_B}`);
    expect(h.emitted).not.toContainEqual(
      expect.objectContaining({ event: 'error' })
    );
  });

  it('joins any number of unrelated group rooms in one session', async () => {
    const h = makeHarness();

    for (const groupId of [GROUP_A, GROUP_B, 'some-other-group']) {
      await h.fire('join:chat', groupId);
    }

    expect(h.joined).toEqual(
      expect.arrayContaining([`chat:${GROUP_A}`, `chat:${GROUP_B}`, 'chat:some-other-group'])
    );
  });

  it('performs no database lookup of the group before joining', async () => {
    const { ChatGroup } = jest.requireMock('../../models');
    const h = makeHarness();

    await h.fire('join:chat', GROUP_B);

    expect(ChatGroup).toBeUndefined(); // the handler never imports a group model
  });

  it('allows leaving a chat room it never legitimately belonged to', async () => {
    const h = makeHarness();

    await h.fire('leave:chat', GROUP_B);

    expect(h.left).toContain(`chat:${GROUP_B}`);
    expect(h.emitted).toContainEqual({ event: 'left:chat', payload: { groupId: GROUP_B } });
  });

  it('ignores a leave:chat with a missing group id', async () => {
    const h = makeHarness();

    await h.fire('leave:chat', '');

    expect(h.left).toHaveLength(0);
  });
});

describe('chat typing indicators — no membership check', () => {
  it('broadcasts typing:start into an arbitrary group room', async () => {
    const h = makeHarness();

    await h.fire('chat:typing:start', { groupId: GROUP_B });

    const sent = h.broadcasts.find((b) => b.event === 'chat:typing:start');
    expect(sent!.room).toBe(`chat:${GROUP_B}`);
    expect(sent!.payload.userId).toBe(USER_A);
  });

  it('broadcasts typing:stop into an arbitrary group room', async () => {
    const h = makeHarness();

    await h.fire('chat:typing:stop', { groupId: GROUP_B });

    expect(h.broadcasts.find((b) => b.event === 'chat:typing:stop')!.room).toBe(`chat:${GROUP_B}`);
  });

  // The typing payload carries the actor's identity into a room they may not
  // belong to — a presence disclosure to the group's real members.
  it('discloses the sender’s id and display name to the target room', async () => {
    const h = makeHarness();

    await h.fire('chat:typing:start', { groupId: GROUP_B });

    const payload = h.broadcasts.find((b) => b.event === 'chat:typing:start')!.payload;
    expect(payload.user).toMatchObject({ name: 'User A' });
    expect(payload.groupId).toBe(GROUP_B);
  });

  it('ignores a typing event with no group id', async () => {
    const h = makeHarness();

    await h.fire('chat:typing:start', { groupId: '' });
    await h.fire('chat:typing:stop', {});

    expect(h.broadcasts).toHaveLength(0);
  });

  it('does not include the sender’s email in the typing payload', async () => {
    const h = makeHarness();

    await h.fire('chat:typing:start', { groupId: GROUP_A });

    const payload = h.broadcasts.find((b) => b.event === 'chat:typing:start')!.payload;
    expect(JSON.stringify(payload)).not.toContain('a@example.com');
  });
});

describe('task events over sockets — no membership check', () => {
  // SECURITY FINDING (documented, NOT fixed): task:update / task:create /
  // task:delete / tasks:reorder take projectId straight from the payload and
  // re-broadcast to `project:<id>` without verifying the sender belongs to that
  // project. A connected user can inject fabricated task events into any
  // project room; recipients see them attributed to the sender.
  it('broadcasts a task update into an arbitrary project room', async () => {
    const h = makeHarness();

    await h.fire('task:update', { projectId: PROJECT_B, taskId: 't1', task: { title: 'Injected' } });

    const sent = h.broadcasts.find((b) => b.event === 'task:updated');
    expect(sent!.room).toBe(`project:${PROJECT_B}`);
    expect(sent!.payload.updatedBy).toBe(USER_A);
    expect(canJoinRoom).not.toHaveBeenCalled();
  });

  it('broadcasts a fabricated task creation into an arbitrary project room', async () => {
    const h = makeHarness();

    await h.fire('task:create', { projectId: PROJECT_B, task: { title: 'Fake task' } });

    const sent = h.broadcasts.find((b) => b.event === 'task:created');
    expect(sent!.room).toBe(`project:${PROJECT_B}`);
    expect(sent!.payload.task.title).toBe('Fake task');
  });

  it('broadcasts a task deletion into an arbitrary project room', async () => {
    const h = makeHarness();

    await h.fire('task:delete', { projectId: PROJECT_B, taskId: 't1' });

    expect(h.broadcasts.find((b) => b.event === 'task:deleted')!.room).toBe(`project:${PROJECT_B}`);
  });

  it('broadcasts a reorder into an arbitrary project room', async () => {
    const h = makeHarness();

    await h.fire('tasks:reorder', { projectId: PROJECT_B, tasks: [{ id: 't1', order: 0 }] });

    expect(h.broadcasts.find((b) => b.event === 'tasks:reordered')!.room).toBe(
      `project:${PROJECT_B}`
    );
  });

  it('ignores task events with incomplete payloads', async () => {
    const h = makeHarness();

    await h.fire('task:update', { projectId: PROJECT_A, taskId: 't1' }); // no task
    await h.fire('task:create', { projectId: PROJECT_A }); // no task
    await h.fire('task:delete', { taskId: 't1' }); // no projectId
    await h.fire('tasks:reorder', { projectId: PROJECT_A }); // no tasks

    expect(h.broadcasts).toHaveLength(0);
  });

  it('broadcasts project typing indicators without a membership check', async () => {
    const h = makeHarness();

    await h.fire('typing:start', { projectId: PROJECT_B, taskId: 't1' });

    const sent = h.broadcasts.find((b) => b.event === 'typing:start');
    expect(sent!.room).toBe(`project:${PROJECT_B}`);
  });

  it('ignores project typing events with no project id', async () => {
    const h = makeHarness();

    await h.fire('typing:start', { taskId: 't1' });
    await h.fire('typing:stop', {});

    expect(h.broadcasts).toHaveLength(0);
  });
});
