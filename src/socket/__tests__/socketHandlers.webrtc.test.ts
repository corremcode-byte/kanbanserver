/**
 * WebRTC signalling over Socket.IO: one-to-one calls and group calls.
 *
 * Same fake io/socket harness as socketHandlers.chat.test.ts — handlers are
 * captured and invoked directly, with no real peer connections or networking.
 *
 * Actor/target model: USER_A is the connected socket's user. USER_B and USER_C
 * are other accounts; GROUP_B belongs to a project USER_A cannot access.
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
import { User } from '../../models';
import { setupSocketHandlers } from '../socketHandlers';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const USER_C = '507f1f77bcf86cd799439033';
const GROUP_A = '707f1f77bcf86cd7994390a1';
const GROUP_B = '707f1f77bcf86cd7994390b2';

interface Harness {
  socket: any;
  emitted: Array<{ event: string; payload: any }>;
  sent: Array<{ room: string; event: string; payload: any }>;
  /** Clears what has been captured so far, e.g. the connection handshake. */
  reset: () => void;
  fire: (event: string, ...args: any[]) => Promise<any>;
}

function makeHarness(userId: string = USER_A): Harness {
  const handlers = new Map<string, Function>();
  const emitted: Harness['emitted'] = [];
  const sent: Harness['sent'] = [];

  const socket: any = {
    id: `socket-${userId}`,
    data: {},
    user: { _id: userId, name: 'Actor', email: 'actor@example.com' },
    handshake: { address: '127.0.0.1', headers: {} },
    on: jest.fn((event: string, handler: Function) => handlers.set(event, handler)),
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn((event: string, payload: any) => emitted.push({ event, payload })),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: any) => sent.push({ room, event, payload }),
    })),
    disconnect: jest.fn(),
  };

  const io: any = {
    on: jest.fn(),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: any) => sent.push({ room, event, payload }),
    })),
  };

  (getSocketUserId as jest.Mock).mockReturnValue(userId);

  let connectionHandler: Function = () => {};
  io.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'connection') connectionHandler = cb;
  });
  setupSocketHandlers(io);
  connectionHandler(socket);

  return {
    socket,
    emitted,
    sent,
    reset: () => {
      emitted.length = 0;
      sent.length = 0;
    },
    fire: async (event: string, ...args: any[]) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      return handler(...args);
    },
  };
}

/** Finds the first message delivered to a given room. */
function toRoom(h: Harness, room: string) {
  return h.sent.filter((s) => s.room === room);
}

const OFFER = { type: 'offer', sdp: 'v=0...' };
const ANSWER = { type: 'answer', sdp: 'v=0...' };
const CANDIDATE = { candidate: 'candidate:1 1 UDP ...', sdpMid: '0' };

beforeEach(() => {
  (canJoinRoom as jest.Mock).mockResolvedValue(true);
  (User.findById as jest.Mock).mockReturnValue({
    select: jest.fn().mockResolvedValue({ displayName: 'Actor', photoURL: null, email: 'a@x.com' }),
  });
});

describe('call:initiate — one-to-one', () => {
  it('rejects a payload missing callId, receiverId or groupId', async () => {
    const h = makeHarness();
    h.reset();

    for (const bad of [
      { callType: 'video', receiverId: USER_B, groupId: GROUP_A },
      { callId: 'c1', callType: 'video', groupId: GROUP_A },
      { callId: 'c1', callType: 'video', receiverId: USER_B },
    ]) {
      await h.fire('call:initiate', bad);
    }

    expect(h.emitted.every((e) => e.event === 'error')).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it('rings the receiver’s personal room and forwards the SDP offer', async () => {
    const h = makeHarness();

    await h.fire('call:initiate', {
      callId: 'call-1',
      callType: 'video',
      receiverId: USER_B,
      groupId: GROUP_A,
      callerName: 'Actor',
      offer: OFFER,
    });

    const delivered = toRoom(h, `user:${USER_B}`);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].event).toBe('call:incoming');
    expect(delivered[0].payload.offer).toEqual(OFFER);
  });

  it('stamps the caller identity from the socket, not from the payload', async () => {
    const h = makeHarness();

    await h.fire('call:initiate', {
      callId: 'call-1',
      callType: 'voice',
      receiverId: USER_B,
      groupId: GROUP_A,
      callerId: USER_C, // spoof attempt
      callerName: 'Actor',
      offer: OFFER,
    });

    expect(toRoom(h, `user:${USER_B}`)[0].payload.callerId).toBe(USER_A);
  });

  // SECURITY FINDING (documented, NOT fixed): call:initiate never checks that
  // caller and receiver share a chat group or project. Any authenticated user
  // can ring any other user by id, and the groupId/groupName shown to the
  // callee are taken verbatim from the caller's payload — so the call can be
  // made to appear to originate from a group the caller does not belong to.
  it('rings a user with no shared group, using an attacker-supplied group name', async () => {
    const h = makeHarness();

    await h.fire('call:initiate', {
      callId: 'call-1',
      callType: 'video',
      receiverId: USER_B,
      groupId: GROUP_B,
      groupName: 'Executive Team',
      callerName: 'Actor',
      offer: OFFER,
    });

    const payload = toRoom(h, `user:${USER_B}`)[0].payload;
    expect(payload.groupId).toBe(GROUP_B);
    expect(payload.groupName).toBe('Executive Team');
    expect(canJoinRoom).not.toHaveBeenCalled();
  });

  it('performs no group membership lookup before ringing', async () => {
    const h = makeHarness();

    await h.fire('call:initiate', {
      callId: 'call-1',
      callType: 'video',
      receiverId: USER_B,
      groupId: GROUP_B,
      callerName: 'Actor',
      offer: OFFER,
    });

    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('call:accept / reject / end / busy — participant identity is not verified', () => {
  it('forwards an answer to the stated caller', async () => {
    const h = makeHarness();

    await h.fire('call:accept', { callId: 'call-1', callerId: USER_B, answer: ANSWER });

    const delivered = toRoom(h, `user:${USER_B}`);
    expect(delivered[0].event).toBe('call:accepted');
    expect(delivered[0].payload.answer).toEqual(ANSWER);
  });

  it('rejects an accept payload missing callId or callerId', async () => {
    const h = makeHarness();
    h.reset();

    await h.fire('call:accept', { callId: 'call-1' });
    await h.fire('call:accept', { callerId: USER_B });

    expect(h.emitted.every((e) => e.event === 'error')).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  // SECURITY FINDING (documented, NOT fixed): none of the call lifecycle
  // handlers verifies that the socket's user is actually a party to the call
  // they name. A third party who learns (or guesses) a callId can answer,
  // reject, end or mark-busy someone else's call, and the notification is
  // delivered to whatever user id they supply.
  it('lets an uninvolved user answer a call between two other people', async () => {
    const h = makeHarness(USER_C); // neither caller nor callee

    await h.fire('call:accept', { callId: 'call-1', callerId: USER_A, answer: ANSWER });

    expect(toRoom(h, `user:${USER_A}`)[0].event).toBe('call:accepted');
  });

  it('lets an uninvolved user reject a call on someone else’s behalf', async () => {
    const h = makeHarness(USER_C);

    await h.fire('call:reject', { callId: 'call-1', callerId: USER_A, reason: 'spoofed' });

    const delivered = toRoom(h, `user:${USER_A}`)[0];
    expect(delivered.event).toBe('call:rejected');
    expect(delivered.payload.reason).toBe('spoofed');
  });

  it('lets an uninvolved user tear down a call', async () => {
    const h = makeHarness(USER_C);

    await h.fire('call:end', { callId: 'call-1', receiverId: USER_B, reason: 'forced' });

    expect(toRoom(h, `user:${USER_B}`)[0].event).toBe('call:ended');
  });

  it('lets an uninvolved user mark a call busy', async () => {
    const h = makeHarness(USER_C);

    await h.fire('call:busy', { callId: 'call-1', callerId: USER_A });

    expect(toRoom(h, `user:${USER_A}`)[0].event).toBe('call:busy');
  });

  it('applies a default reason when none is supplied', async () => {
    const h = makeHarness();

    await h.fire('call:reject', { callId: 'call-1', callerId: USER_B });
    await h.fire('call:end', { callId: 'call-1', receiverId: USER_B });

    expect(h.sent[0].payload.reason).toBe('Call rejected');
    expect(h.sent[1].payload.reason).toBe('Call ended');
  });

  it('silently ignores reject/busy payloads with missing ids', async () => {
    const h = makeHarness();

    await h.fire('call:busy', { callId: 'call-1' });
    await h.fire('call:busy', { callerId: USER_B });

    expect(h.sent).toHaveLength(0);
  });
});

describe('call:ice-candidate', () => {
  it('forwards a candidate to the named peer', async () => {
    const h = makeHarness();

    await h.fire('call:ice-candidate', {
      callId: 'call-1',
      receiverId: USER_B,
      candidate: CANDIDATE,
    });

    const delivered = toRoom(h, `user:${USER_B}`)[0];
    expect(delivered.event).toBe('call:ice-candidate');
    expect(delivered.payload.candidate).toEqual(CANDIDATE);
  });

  it('drops a candidate payload missing any required field', async () => {
    const h = makeHarness();

    await h.fire('call:ice-candidate', { callId: 'c1', receiverId: USER_B });
    await h.fire('call:ice-candidate', { callId: 'c1', candidate: CANDIDATE });
    await h.fire('call:ice-candidate', { receiverId: USER_B, candidate: CANDIDATE });

    expect(h.sent).toHaveLength(0);
  });

  it('forwards candidates to an arbitrary user id without verifying the call', async () => {
    const h = makeHarness(USER_C);

    await h.fire('call:ice-candidate', {
      callId: 'someone-elses-call',
      receiverId: USER_A,
      candidate: CANDIDATE,
    });

    expect(toRoom(h, `user:${USER_A}`)).toHaveLength(1);
  });
});

describe('group-call:initiate', () => {
  it('rejects a payload with no callId, groupId or members', async () => {
    const h = makeHarness();
    h.reset();

    const badPayloads: any[] = [
      { groupId: GROUP_A, memberIds: [USER_B] },
      { callId: 'gc1', memberIds: [USER_B] },
      { callId: 'gc1', groupId: GROUP_A, memberIds: [] },
      { callId: 'gc1', groupId: GROUP_A },
    ];

    for (const bad of badPayloads) {
      await h.fire('group-call:initiate', bad);
    }

    expect(h.emitted.every((e) => e.event === 'error')).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it('notifies every listed member’s personal room', async () => {
    const h = makeHarness();

    await h.fire('group-call:initiate', {
      callId: 'gc-1',
      callType: 'video',
      groupId: GROUP_A,
      groupName: 'Team',
      memberIds: [USER_B, USER_C],
      initiatorName: 'Actor',
    });

    expect(toRoom(h, `user:${USER_B}`)[0].event).toBe('group-call:incoming');
    expect(toRoom(h, `user:${USER_C}`)[0].event).toBe('group-call:incoming');
  });

  it('records the initiator from the socket rather than the payload', async () => {
    const h = makeHarness();

    await h.fire('group-call:initiate', {
      callId: 'gc-1',
      callType: 'voice',
      groupId: GROUP_A,
      groupName: 'Team',
      memberIds: [USER_B],
      initiatorId: USER_C, // spoof attempt
      initiatorName: 'Actor',
    });

    expect(toRoom(h, `user:${USER_B}`)[0].payload.initiatorId).toBe(USER_A);
  });

  // SECURITY FINDING (documented, NOT fixed): the invite list is taken straight
  // from memberIds with no check that those users belong to groupId — or that
  // the initiator does. Any authenticated user can ring arbitrary users under
  // an arbitrary group name.
  it('rings arbitrary users for a group the initiator does not belong to', async () => {
    const h = makeHarness();

    await h.fire('group-call:initiate', {
      callId: 'gc-1',
      callType: 'video',
      groupId: GROUP_B,
      groupName: 'Board Meeting',
      memberIds: [USER_B, USER_C],
      initiatorName: 'Actor',
    });

    expect(toRoom(h, `user:${USER_B}`)[0].payload.groupName).toBe('Board Meeting');
    expect(toRoom(h, `user:${USER_C}`)).toHaveLength(1);
  });
});

describe('group-call:join — membership is not checked', () => {
  /** Starts a call as USER_A so the shared activeGroupCalls map has an entry. */
  async function startCall(callId: string, groupId = GROUP_A) {
    const initiator = makeHarness(USER_A);
    await initiator.fire('group-call:initiate', {
      callId,
      callType: 'video',
      groupId,
      groupName: 'Team',
      memberIds: [USER_B],
      initiatorName: 'Actor A',
    });
    return initiator;
  }

  it('rejects a join with no call id', async () => {
    const h = makeHarness();

    await h.fire('group-call:join', { callId: '', displayName: 'X' });

    expect(h.emitted).toContainEqual({ event: 'error', payload: { message: 'Invalid call ID' } });
  });

  it('rejects a join for a call that does not exist', async () => {
    const h = makeHarness();

    await h.fire('group-call:join', { callId: 'no-such-call', displayName: 'X' });

    expect(h.emitted).toContainEqual({ event: 'error', payload: { message: 'Call not found' } });
  });

  it('admits a legitimate invitee and announces them to existing participants', async () => {
    await startCall('gc-join-1');
    const joiner = makeHarness(USER_B);

    await joiner.fire('group-call:join', { callId: 'gc-join-1', displayName: 'User B' });

    expect(toRoom(joiner, `user:${USER_A}`)[0].event).toBe('group-call:user-joined');
  });

  it('sends the joiner the existing participant list', async () => {
    await startCall('gc-join-2');
    const joiner = makeHarness(USER_B);

    await joiner.fire('group-call:join', { callId: 'gc-join-2', displayName: 'User B' });

    const list = joiner.emitted.find((e) => e.event === 'group-call:participants');
    expect(list!.payload.participants.map((p: any) => p.oderId)).toContain(USER_A);
  });

  it('resolves the joiner’s display name from the database, overriding the payload', async () => {
    await startCall('gc-join-3');
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({ displayName: 'Real Name', photoURL: null }),
    });
    const joiner = makeHarness(USER_B);

    await joiner.fire('group-call:join', { callId: 'gc-join-3', displayName: 'Spoofed Name' });

    expect(toRoom(joiner, `user:${USER_A}`)[0].payload.displayName).toBe('Real Name');
  });

  // SECURITY FINDING (documented, NOT fixed): group-call:join checks only that
  // the callId exists. It never verifies the joiner was invited, belongs to the
  // group, or has any project access — so anyone who learns a callId can join
  // the call and immediately receives the roster of existing participants.
  it('admits a user who was never invited and hands them the participant roster', async () => {
    await startCall('gc-join-4');
    const uninvited = makeHarness(USER_C); // not in memberIds

    await uninvited.fire('group-call:join', { callId: 'gc-join-4', displayName: 'Intruder' });

    const roster = uninvited.emitted.find((e) => e.event === 'group-call:participants');
    expect(roster).toBeDefined();
    expect(roster!.payload.participants.map((p: any) => p.oderId)).toContain(USER_A);
    expect(uninvited.emitted).not.toContainEqual(
      expect.objectContaining({ event: 'error' })
    );
  });

  it('admits a user for a call whose group belongs to another project', async () => {
    await startCall('gc-join-5', GROUP_B);
    const outsider = makeHarness(USER_C);

    await outsider.fire('group-call:join', { callId: 'gc-join-5', displayName: 'Outsider' });

    expect(outsider.emitted.find((e) => e.event === 'group-call:participants')).toBeDefined();
  });

  it('falls back to the supplied display name when the user lookup fails', async () => {
    await startCall('gc-join-6');
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockRejectedValue(new Error('lookup failed')),
    });
    const joiner = makeHarness(USER_B);

    await joiner.fire('group-call:join', { callId: 'gc-join-6', displayName: 'Fallback Name' });

    expect(toRoom(joiner, `user:${USER_A}`)[0].payload.displayName).toBe('Fallback Name');
  });
});

describe('group-call signalling relays', () => {
  it('relays an offer to the named peer', async () => {
    const h = makeHarness();

    await h.fire('group-call:offer', { callId: 'gc-1', toUserId: USER_B, offer: OFFER });

    const delivered = toRoom(h, `user:${USER_B}`);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.offer).toEqual(OFFER);
  });

  it('relays an answer to the named peer', async () => {
    const h = makeHarness();

    await h.fire('group-call:answer', { callId: 'gc-1', toUserId: USER_B, answer: ANSWER });

    expect(toRoom(h, `user:${USER_B}`)[0].payload.answer).toEqual(ANSWER);
  });

  it('relays an ICE candidate to the named peer', async () => {
    const h = makeHarness();

    await h.fire('group-call:ice-candidate', {
      callId: 'gc-1',
      toUserId: USER_B,
      candidate: CANDIDATE,
    });

    expect(toRoom(h, `user:${USER_B}`)[0].payload.candidate).toEqual(CANDIDATE);
  });

  it('attributes each relayed frame to the sending socket’s user', async () => {
    const h = makeHarness(USER_C);

    await h.fire('group-call:offer', { callId: 'gc-1', toUserId: USER_B, offer: OFFER });

    const payload = toRoom(h, `user:${USER_B}`)[0].payload;
    expect(JSON.stringify(payload)).toContain(USER_C);
  });

  it('relays to an arbitrary target without verifying call participation', async () => {
    const h = makeHarness(USER_C);

    await h.fire('group-call:offer', {
      callId: 'a-call-they-are-not-in',
      toUserId: USER_A,
      offer: OFFER,
    });

    expect(toRoom(h, `user:${USER_A}`)).toHaveLength(1);
  });

  it('ignores relay payloads missing the target user', async () => {
    const h = makeHarness();

    await h.fire('group-call:offer', { callId: 'gc-1', offer: OFFER });
    await h.fire('group-call:answer', { callId: 'gc-1', answer: ANSWER });
    await h.fire('group-call:ice-candidate', { callId: 'gc-1', candidate: CANDIDATE });

    expect(h.sent).toHaveLength(0);
  });
});

describe('group-call:leave and end-all', () => {
  async function startCall(callId: string) {
    const initiator = makeHarness(USER_A);
    await initiator.fire('group-call:initiate', {
      callId,
      callType: 'video',
      groupId: GROUP_A,
      groupName: 'Team',
      memberIds: [USER_B],
      initiatorName: 'Actor A',
    });
    return initiator;
  }

  it('ignores a leave with no call id', async () => {
    const h = makeHarness();

    await h.fire('group-call:leave', { callId: '' });

    expect(h.sent).toHaveLength(0);
  });

  it('ignores a leave for an unknown call', async () => {
    const h = makeHarness();

    await h.fire('group-call:leave', { callId: 'no-such-call' });

    expect(h.sent).toHaveLength(0);
  });

  it('notifies remaining participants when someone leaves', async () => {
    await startCall('gc-leave-1');
    const joiner = makeHarness(USER_B);
    await joiner.fire('group-call:join', { callId: 'gc-leave-1', displayName: 'User B' });

    const before = joiner.sent.length;
    await joiner.fire('group-call:leave', { callId: 'gc-leave-1' });

    const left = joiner.sent.slice(before).find((s) => s.event === 'group-call:user-left');
    expect(left).toBeDefined();
    expect(left!.room).toBe(`user:${USER_A}`);
  });

  it('ignores an end-all for an unknown call', async () => {
    const h = makeHarness();

    await h.fire('group-call:end-all', { callId: 'no-such-call' });

    expect(h.sent).toHaveLength(0);
  });

  // The implementation deliberately notifies nobody on rejection — the user is
  // simply never added to the call. Locked in so a future change is visible.
  it('notifies nobody when an invitee rejects a group call', async () => {
    await startCall('gc-reject-1');
    const invitee = makeHarness(USER_B);

    await invitee.fire('group-call:reject', { callId: 'gc-reject-1', reason: 'busy' });

    expect(invitee.sent).toHaveLength(0);
  });

  it('ignores a rejection with no call id', async () => {
    const h = makeHarness();

    await h.fire('group-call:reject', { callId: '' });

    expect(h.sent).toHaveLength(0);
  });
});
