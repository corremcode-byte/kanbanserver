/**
 * Socket.IO connection authentication and room-access checks.
 *
 * The middleware is invoked directly with a fake socket object — no real
 * networking, no socket.io-client.
 *
 * Actor/target model: USER_A is the connecting user; USER_B and PROJECT_B
 * belong to an unrelated account.
 */

import jwt from 'jsonwebtoken';

jest.mock('../../models', () => ({
  User: { findById: jest.fn() },
  Project: { findById: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { User, Project } from '../../models';
import { socketAuth, getSocketUserId, canJoinRoom, AuthenticatedSocket } from '../socketAuth';

const TEST_SECRET = 'test-jwt-secret-for-socket-auth';
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

/** A minimal stand-in for a connecting Socket.IO socket. */
function makeSocket(token?: any, overrides: any = {}): AuthenticatedSocket {
  return {
    id: 'socket-1',
    handshake: { auth: token === undefined ? {} : { token }, address: '127.0.0.1', headers: {} },
    ...overrides,
  } as any;
}

function makeUser(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => USER_A },
    email: 'a@example.com',
    displayName: 'User A',
    isActive: true,
    ...overrides,
  };
}

function sign(payload: object, secret = TEST_SECRET, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, secret, options);
}

/** Runs socketAuth and returns the error (if any) passed to next(). */
async function connect(socket: AuthenticatedSocket): Promise<Error | undefined> {
  let captured: Error | undefined;
  await socketAuth(socket, (err?: Error) => {
    captured = err;
  });
  return captured;
}

beforeEach(() => {
  (User.findById as jest.Mock).mockResolvedValue(makeUser());
});

describe('socketAuth — token presence and shape', () => {
  it('rejects a handshake with no token', async () => {
    const err = await connect(makeSocket());

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('Authentication token required');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects an empty-string token', async () => {
    const err = await connect(makeSocket(''));

    expect(err!.message).toBe('Authentication token required');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a null token', async () => {
    const err = await connect(makeSocket(null));

    expect(err!.message).toBe('Authentication token required');
  });

  it('rejects a handshake with no auth object at all', async () => {
    const socket = { id: 's', handshake: { address: '1.1.1.1', headers: {} } } as any;

    const err = await connect(socket);

    expect(err!.message).toBe('Authentication token required');
  });

  it('rejects a malformed token', async () => {
    const err = await connect(makeSocket('not-a-jwt'));

    expect(err!.message).toBe('Authentication failed');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a token signed with a different secret', async () => {
    const err = await connect(makeSocket(sign({ userId: USER_A }, 'attacker-secret')));

    expect(err!.message).toBe('Authentication failed');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const err = await connect(makeSocket(sign({ userId: USER_A }, TEST_SECRET, { expiresIn: '-1h' })));

    expect(err!.message).toBe('Authentication failed');
  });

  it('rejects an unsigned alg:none token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ userId: USER_A })).toString('base64url');

    const err = await connect(makeSocket(`${header}.${body}.`));

    expect(err!.message).toBe('Authentication failed');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('rejects a validly-signed token carrying no user identifier', async () => {
    const err = await connect(makeSocket(sign({ email: 'a@example.com' })));

    expect(err!.message).toBe('Invalid token');
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('socketAuth — account resolution', () => {
  it('accepts a valid token and attaches the user to the socket', async () => {
    const socket = makeSocket(sign({ userId: USER_A }));

    const err = await connect(socket);

    expect(err).toBeUndefined();
    expect(socket.user).toBeDefined();
    expect(socket.user.email).toBe('a@example.com');
  });

  it('accepts the legacy `id` claim as well as `userId`', async () => {
    const socket = makeSocket(sign({ id: USER_A }));

    const err = await connect(socket);

    expect(err).toBeUndefined();
    expect(User.findById).toHaveBeenCalledWith(USER_A);
  });

  it('prefers userId over a conflicting legacy id claim', async () => {
    await connect(makeSocket(sign({ userId: USER_A, id: USER_B })));

    expect(User.findById).toHaveBeenCalledWith(USER_A);
  });

  it('rejects a token naming a deleted account', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);

    const err = await connect(makeSocket(sign({ userId: USER_A })));

    expect(err!.message).toBe('User not found');
  });

  it('rejects a token naming a deactivated account', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ isActive: false }));
    const socket = makeSocket(sign({ userId: USER_A }));

    const err = await connect(socket);

    expect(err!.message).toBe('Account is deactivated');
    expect(socket.user).toBeUndefined();
  });

  it('rejects the connection when the database lookup throws', async () => {
    (User.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const err = await connect(makeSocket(sign({ userId: USER_A })));

    expect(err!.message).toBe('Authentication failed');
  });

  it('derives identity from the database, not from claims in the token', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ email: 'real@example.com' }));
    const socket = makeSocket(sign({ userId: USER_A, email: 'forged@evil.test', role: 'superadmin' }));

    await connect(socket);

    expect(socket.user.email).toBe('real@example.com');
  });

  // FINDING (documented, NOT fixed): socketAuth never checks decoded.jti against
  // user.activeSessions, unlike the HTTP `authenticate` middleware. A token
  // revoked by logout or evicted by a same-device login still opens a socket and
  // keeps receiving real-time events for as long as it is held.
  it('accepts a token whose session has already been revoked', async () => {
    (User.findById as jest.Mock).mockResolvedValue(makeUser({ activeSessions: [] }));
    const socket = makeSocket(sign({ userId: USER_A, jti: 'revoked-session' }));

    const err = await connect(socket);

    expect(err).toBeUndefined();
    expect(socket.user).toBeDefined();
  });

  it('accepts a jti-less token, matching the HTTP layer’s behaviour', async () => {
    (User.findById as jest.Mock).mockResolvedValue(
      makeUser({ activeSessions: [{ jti: 'some-other-session' }] })
    );

    const err = await connect(makeSocket(sign({ userId: USER_A })));

    expect(err).toBeUndefined();
  });
});

describe('getSocketUserId', () => {
  it('returns the stringified id of an authenticated socket', () => {
    expect(getSocketUserId({ user: { _id: { toString: () => USER_A } } } as any)).toBe(USER_A);
  });

  it('returns null for a socket with no user', () => {
    expect(getSocketUserId({} as any)).toBeNull();
    expect(getSocketUserId({ user: {} } as any)).toBeNull();
  });
});

describe('canJoinRoom — project rooms', () => {
  function authed(userId = USER_A): AuthenticatedSocket {
    return { user: { _id: { toString: () => userId } } } as any;
  }

  function makeProject(overrides: Record<string, any> = {}) {
    return {
      _id: PROJECT_A,
      ownerId: { toString: () => USER_B },
      members: [] as any[],
      managers: [] as any[],
      ...overrides,
    };
  }

  beforeEach(() => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject());
  });

  it('denies an unauthenticated socket', async () => {
    await expect(canJoinRoom({} as any, 'project', PROJECT_A)).resolves.toBe(false);
  });

  it('allows the project owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: { toString: () => USER_A } })
    );

    await expect(canJoinRoom(authed(), 'project', PROJECT_A)).resolves.toBe(true);
  });

  it('allows a project member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ members: [{ toString: () => USER_A }] })
    );

    await expect(canJoinRoom(authed(), 'project', PROJECT_A)).resolves.toBe(true);
  });

  it('denies a non-member of another user’s project', async () => {
    await expect(canJoinRoom(authed(), 'project', PROJECT_B)).resolves.toBe(false);
  });

  it('denies a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);

    await expect(canJoinRoom(authed(), 'project', PROJECT_A)).resolves.toBe(false);
  });

  it('returns false rather than throwing when the lookup fails', async () => {
    (Project.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    await expect(canJoinRoom(authed(), 'project', PROJECT_A)).resolves.toBe(false);
  });

  // FINDING (documented, NOT fixed): project managers are not consulted here,
  // so a user who is only in project.managers cannot join the project room even
  // though the HTTP layer treats managers as having access.
  it('denies a project manager who is not also owner or member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ managers: [{ toString: () => USER_A }] })
    );

    await expect(canJoinRoom(authed(), 'project', PROJECT_A)).resolves.toBe(false);
  });

  // FINDING (documented, NOT fixed): the literal room id "all" is granted to
  // every authenticated socket without any lookup, so anything broadcast to
  // `project:all` reaches every connected user.
  it('grants the "all" project room to any authenticated socket without a lookup', async () => {
    await expect(canJoinRoom(authed(), 'project', 'all')).resolves.toBe(true);
    expect(Project.findById).not.toHaveBeenCalled();
  });
});

describe('canJoinRoom — user rooms and unknown room types', () => {
  function authed(userId = USER_A): AuthenticatedSocket {
    return { user: { _id: { toString: () => userId } } } as any;
  }

  it('allows a user to join only their own personal room', async () => {
    await expect(canJoinRoom(authed(), 'user', USER_A)).resolves.toBe(true);
  });

  it('denies joining another user’s personal room', async () => {
    await expect(canJoinRoom(authed(), 'user', USER_B)).resolves.toBe(false);
  });

  // FINDING (documented, NOT fixed): there is no 'chat'/'group' room type, so
  // canJoinRoom cannot authorise chat rooms at all — and join:chat never calls
  // it (see socketHandlers.chat.test.ts).
  it('denies every unrecognised room type, chat included', async () => {
    for (const roomType of ['chat', 'group', 'call', '']) {
      await expect(canJoinRoom(authed(), roomType, 'any-id')).resolves.toBe(false);
    }
  });
});
