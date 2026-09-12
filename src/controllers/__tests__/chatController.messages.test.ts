/**
 * Chat HTTP layer: group access, messages and E2E group keys.
 *
 * Actor/target model: USER_A is the authenticated caller and a member of
 * GROUP_A. GROUP_B belongs to other users; USER_B is an unrelated account.
 */

jest.mock('../../models/ChatGroup', () => ({
  ChatGroup: { findOne: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn() },
}));

jest.mock('../../models/Message', () => ({
  Message: Object.assign(jest.fn(), {
    find: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn(),
    create: jest.fn(),
  }),
}));

jest.mock('../../models/User', () => {
  const User: any = { findById: jest.fn(), find: jest.fn(), findOne: jest.fn() };
  return { __esModule: true, default: User, User };
});

jest.mock('../../utils/adminRecoveryKey', () => ({
  getOrCreateAdminRecoveryKeyPair: jest.fn().mockResolvedValue({
    publicKey: 'admin-recovery-public-key',
    privateKey: new Uint8Array(32),
  }),
}));

jest.mock('../../utils/groupKeyValidation', () => ({
  validateAndBuildKeyEpoch: jest.fn(),
}));

jest.mock('../../socket', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

// chatController imports `{ io } from '../server'`, which would otherwise boot
// the entire Express app (every router, Firebase, cron) just to load the module.
jest.mock('../../server', () => ({
  io: { to: jest.fn(() => ({ emit: jest.fn() })), emit: jest.fn() },
}));

jest.mock('../../services/pushNotificationService', () => ({
  pushNotificationService: { sendToUser: jest.fn(), sendNotification: jest.fn() },
}));

jest.mock('../notificationController', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../models/Notification', () => ({
  Notification: { create: jest.fn(), find: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { ChatGroup } from '../../models/ChatGroup';
import { Message } from '../../models/Message';
import User from '../../models/User';
import { validateAndBuildKeyEpoch } from '../../utils/groupKeyValidation';
import {
  getChatGroup,
  getGroupMessages,
  editMessage,
  deleteMessage,
  getGroupMemberKeys,
  rotateGroupKey,
} from '../chatController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const GROUP_A = '707f1f77bcf86cd7994390a1';
const GROUP_B = '707f1f77bcf86cd7994390b2';
const MESSAGE_B = '807f1f77bcf86cd7994390d2';

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
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A', role: 'member' },
    params: {},
    query: {},
    body: {},
    headers: {},
    protocol: 'https',
    get: () => 'test.example',
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeGroup(overrides: Record<string, any> = {}) {
  return {
    _id: GROUP_A,
    name: 'Group A',
    members: [{ toString: () => USER_A }, { toString: () => USER_B }],
    createdBy: { toString: () => USER_A },
    isActive: true,
    currentKeyVersion: 3,
    toObject() {
      const { toObject, ...rest } = this as any;
      return rest;
    },
    ...overrides,
  };
}

/** ChatGroup.findOne(...).populate().populate() — chainable. */
function mockGroupFindOne(group: any) {
  const chain: any = { populate: jest.fn(() => chain) };
  chain.then = (resolve: any) => Promise.resolve(group).then(resolve);
  (ChatGroup.findOne as jest.Mock).mockReturnValue(chain);
  return chain;
}

/** Message.find(...).populate().sort().skip().limit() — chainable. */
function mockMessageFind(messages: any[]) {
  const chain: any = {};
  for (const m of ['populate', 'sort', 'skip', 'limit']) chain[m] = jest.fn(() => chain);
  chain.then = (resolve: any) => Promise.resolve(messages).then(resolve);
  (Message.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

function makeMessageDoc(overrides: Record<string, any> = {}) {
  return {
    _id: MESSAGE_B,
    groupId: GROUP_A,
    senderId: { toString: () => USER_B },
    encryptedContent: 'cipher',
    nonce: 'nonce',
    keyVersion: 2,
    isDeleted: false,
    createdAt: new Date(),
    isEdited: false,
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    toObject() {
      const { save, populate, toObject, ...rest } = this as any;
      return rest;
    },
    ...overrides,
  };
}

beforeEach(() => {
  (Message.countDocuments as jest.Mock).mockResolvedValue(0);
  mockMessageFind([]);
});

describe('getChatGroup — membership scoping', () => {
  it('scopes the lookup to an active group the caller is a member of', async () => {
    mockGroupFindOne(makeGroup());

    await getChatGroup(makeReq({ params: { groupId: GROUP_A } }), makeRes());

    expect(ChatGroup.findOne).toHaveBeenCalledWith({
      _id: GROUP_A,
      members: USER_A,
      isActive: true,
    });
  });

  it('returns 404 for a group the caller does not belong to', async () => {
    mockGroupFindOne(null);
    const res = makeRes();

    await getChatGroup(makeReq({ params: { groupId: GROUP_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Chat group not found or access denied');
  });

  it('cannot be redirected by a userId supplied in the body', async () => {
    mockGroupFindOne(null);

    await getChatGroup(
      makeReq({ params: { groupId: GROUP_B }, body: { userId: USER_B } }),
      makeRes()
    );

    expect((ChatGroup.findOne as jest.Mock).mock.calls[0][0].members).toBe(USER_A);
  });

  it('returns 500 when the lookup throws', async () => {
    (ChatGroup.findOne as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getChatGroup(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getGroupMessages — membership scoping', () => {
  it('denies a non-member with 403 and never queries messages', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getGroupMessages(makeReq({ params: { groupId: GROUP_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Not authorized to view messages in this group');
    expect(Message.find).not.toHaveBeenCalled();
  });

  it('requires the group to be active', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(null);

    await getGroupMessages(makeReq({ params: { groupId: GROUP_A } }), makeRes());

    expect((ChatGroup.findOne as jest.Mock).mock.calls[0][0]).toEqual({
      _id: GROUP_A,
      members: USER_A,
      isActive: true,
    });
  });

  it('returns messages for a member, excluding deleted ones', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    mockMessageFind([]);
    const res = makeRes();

    await getGroupMessages(makeReq({ params: { groupId: GROUP_A } }), res);

    expect((Message.find as jest.Mock).mock.calls[0][0]).toEqual({
      groupId: GROUP_A,
      isDeleted: false,
    });
    expect(payloadOf(res)).toHaveProperty('messages');
  });

  it('applies the default page size and offset', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    const chain = mockMessageFind([]);

    await getGroupMessages(makeReq({ params: { groupId: GROUP_A } }), makeRes());

    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('honours explicit limit and skip values', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    const chain = mockMessageFind([]);

    await getGroupMessages(
      makeReq({ params: { groupId: GROUP_A }, query: { limit: '10', skip: '20' } }),
      makeRes()
    );

    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it('reports hasMore from the total count', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (Message.countDocuments as jest.Mock).mockResolvedValue(200);
    const res = makeRes();

    await getGroupMessages(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(payloadOf(res).totalCount).toBe(200);
    expect(payloadOf(res).hasMore).toBe(true);
  });

  it('returns 500 when the message query throws', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (Message.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getGroupMessages(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('editMessage — sender ownership', () => {
  it('returns 404 for a nonexistent message', async () => {
    (Message.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await editMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies editing another user’s message', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_B } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await editMessage(
      makeReq({ params: { messageId: MESSAGE_B }, body: { encryptedContent: 'x', nonce: 'n' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You can only edit your own messages');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses to edit a deleted message', async () => {
    (Message.findById as jest.Mock).mockResolvedValue(
      makeMessageDoc({ senderId: { toString: () => USER_A }, isDeleted: true })
    );
    const res = makeRes();

    await editMessage(
      makeReq({ params: { messageId: MESSAGE_B }, body: { encryptedContent: 'x', nonce: 'n' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot edit a deleted message');
  });

  it('refuses to edit a message older than 24 hours', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    (Message.findById as jest.Mock).mockResolvedValue(
      makeMessageDoc({ senderId: { toString: () => USER_A }, createdAt: old })
    );
    const res = makeRes();

    await editMessage(
      makeReq({ params: { messageId: MESSAGE_B }, body: { encryptedContent: 'x', nonce: 'n' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot edit a message older than 24 hours');
  });

  it('updates ciphertext and marks the message edited for its own sender', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_A } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (ChatGroup.findById as jest.Mock).mockResolvedValue(makeGroup());

    await editMessage(
      makeReq({
        params: { messageId: MESSAGE_B },
        body: { encryptedContent: 'new-cipher', nonce: 'new-nonce', keyVersion: 4 },
      }),
      makeRes()
    );

    expect(doc.encryptedContent).toBe('new-cipher');
    expect(doc.keyVersion).toBe(4);
    expect(doc.isEdited).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('leaves keyVersion untouched when the client omits or sends an invalid one', async () => {
    for (const keyVersion of [undefined, 0, -1, 'two', 1.5]) {
      const doc = makeMessageDoc({ senderId: { toString: () => USER_A }, keyVersion: 2 });
      (Message.findById as jest.Mock).mockResolvedValue(doc);
      (ChatGroup.findById as jest.Mock).mockResolvedValue(makeGroup());

      await editMessage(
        makeReq({
          params: { messageId: MESSAGE_B },
          body: { encryptedContent: 'c', nonce: 'n', keyVersion },
        }),
        makeRes()
      );

      expect(doc.keyVersion).toBe(2);
    }
  });
});

describe('deleteMessage — sender, group creator and permission', () => {
  it('returns 404 for a nonexistent message', async () => {
    (Message.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when the owning group is gone', async () => {
    (Message.findById as jest.Mock).mockResolvedValue(makeMessageDoc());
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Chat group not found');
  });

  it('denies a non-sender who is not the group creator', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_B } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(
      makeGroup({ createdBy: { toString: () => USER_B } })
    );
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('denies the sender when they lack the chat deleteMessages permission', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_A } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { chat: { deleteMessages: false } } },
    });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(
      makeGroup({ createdBy: { toString: () => USER_B } })
    );
    const res = makeRes();

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('allows the sender who holds the deleteMessages permission', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_A } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { chat: { deleteMessages: true } } },
    });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(
      makeGroup({ createdBy: { toString: () => USER_B } })
    );

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), makeRes());

    expect(doc.isDeleted).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('allows the group creator to delete another member’s message', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_B } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(
      makeGroup({ createdBy: { toString: () => USER_A } })
    );

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), makeRes());

    expect(doc.isDeleted).toBe(true);
  });

  it('soft-deletes rather than removing the record', async () => {
    const doc = makeMessageDoc({ senderId: { toString: () => USER_B } });
    (Message.findById as jest.Mock).mockResolvedValue(doc);
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
    (ChatGroup.findById as jest.Mock).mockResolvedValue(
      makeGroup({ createdBy: { toString: () => USER_A } })
    );

    await deleteMessage(makeReq({ params: { messageId: MESSAGE_B } }), makeRes());

    expect(doc.isDeleted).toBe(true);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe('getGroupMemberKeys — E2E key distribution', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A }, user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(ChatGroup.findOne).not.toHaveBeenCalled();
  });

  it('denies a non-member of the group', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(User.find).not.toHaveBeenCalled();
  });

  it('scopes the group lookup to an active group the caller belongs to', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(null);

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A } }), makeRes());

    expect(ChatGroup.findOne).toHaveBeenCalledWith({
      _id: GROUP_A,
      members: USER_A,
      isActive: true,
    });
  });

  it('returns only public keys, never private material', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (User.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue([
        { _id: { toString: () => USER_A }, encryptionPublicKey: 'pub-a' },
        { _id: { toString: () => USER_B }, encryptionPublicKey: 'pub-b' },
      ]),
    });
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A } }), res);

    const body = payloadOf(res);
    expect(body.memberKeys).toHaveLength(2);
    expect(body.currentKeyVersion).toBe(3);
    expect(JSON.stringify(body)).not.toContain('privateKey');
    expect(JSON.stringify(body)).not.toContain('encryptionPrivateKey');
  });

  it('omits members who have registered no public key', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (User.find as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue([
        { _id: { toString: () => USER_A }, encryptionPublicKey: 'pub-a' },
        { _id: { toString: () => USER_B }, encryptionPublicKey: undefined },
      ]),
    });
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(payloadOf(res).memberKeys.map((k: any) => k.userId)).toEqual([USER_A]);
  });

  it('defaults currentKeyVersion to 1 when the group has none', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup({ currentKeyVersion: undefined }));
    (User.find as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue([]) });
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(payloadOf(res).currentKeyVersion).toBe(1);
  });

  it('includes the admin recovery public key', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (User.find as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue([]) });
    const res = makeRes();

    await getGroupMemberKeys(makeReq({ params: { groupId: GROUP_A } }), res);

    expect(payloadOf(res).adminRecoveryPublicKey).toBe('admin-recovery-public-key');
  });
});

describe('rotateGroupKey — epoch validation and concurrency', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    const res = makeRes();

    await rotateGroupKey(makeReq({ params: { groupId: GROUP_A }, user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('requires a valid expectedCurrentVersion', async () => {
    for (const expectedCurrentVersion of [undefined, 0, -1, 'three', 2.5]) {
      const res = makeRes();
      await rotateGroupKey(
        makeReq({ params: { groupId: GROUP_A }, body: { expectedCurrentVersion } }),
        res
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('expectedCurrentVersion is required');
    }
    expect(ChatGroup.findOne).not.toHaveBeenCalled();
  });

  it('denies a non-member attempting to rotate a group key', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await rotateGroupKey(
      makeReq({ params: { groupId: GROUP_B }, body: { expectedCurrentVersion: 1 } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(validateAndBuildKeyEpoch).not.toHaveBeenCalled();
  });

  it('rejects a malformed key rotation payload', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (validateAndBuildKeyEpoch as jest.Mock).mockReturnValue(null);
    const res = makeRes();

    await rotateGroupKey(
      makeReq({
        params: { groupId: GROUP_A },
        body: { expectedCurrentVersion: 3, memberKeys: [], adminSealedKey: null },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid or malformed key rotation payload');
    expect(ChatGroup.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('builds the next epoch against the group’s current member list', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (validateAndBuildKeyEpoch as jest.Mock).mockReturnValue({
      memberKeys: [{ userId: USER_A, sealedKey: 'sk' }],
      adminSealedKey: 'ask',
    });
    (ChatGroup.findOneAndUpdate as jest.Mock).mockResolvedValue(makeGroup({ currentKeyVersion: 4 }));

    await rotateGroupKey(
      makeReq({ params: { groupId: GROUP_A }, body: { expectedCurrentVersion: 3 } }),
      makeRes()
    );

    const [, newVersion, memberIds] = (validateAndBuildKeyEpoch as jest.Mock).mock.calls[0];
    expect(newVersion).toBe(4);
    expect(memberIds).toEqual([USER_A, USER_B]);
  });

  it('applies the rotation with an optimistic-concurrency filter on the current version', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (validateAndBuildKeyEpoch as jest.Mock).mockReturnValue({ memberKeys: [], adminSealedKey: 'a' });
    (ChatGroup.findOneAndUpdate as jest.Mock).mockResolvedValue(makeGroup({ currentKeyVersion: 4 }));

    await rotateGroupKey(
      makeReq({ params: { groupId: GROUP_A }, body: { expectedCurrentVersion: 3 } }),
      makeRes()
    );

    const filter = (ChatGroup.findOneAndUpdate as jest.Mock).mock.calls[0][0];
    expect(filter).toEqual({ _id: GROUP_A, members: USER_A, currentKeyVersion: 3 });
  });

  it('pushes a new key epoch rather than replacing the history', async () => {
    (ChatGroup.findOne as jest.Mock).mockResolvedValue(makeGroup());
    (validateAndBuildKeyEpoch as jest.Mock).mockReturnValue({
      memberKeys: [{ userId: USER_A, sealedKey: 'sk' }],
      adminSealedKey: 'ask',
    });
    (ChatGroup.findOneAndUpdate as jest.Mock).mockResolvedValue(makeGroup({ currentKeyVersion: 4 }));

    await rotateGroupKey(
      makeReq({ params: { groupId: GROUP_A }, body: { expectedCurrentVersion: 3 } }),
      makeRes()
    );

    const update = (ChatGroup.findOneAndUpdate as jest.Mock).mock.calls[0][1];
    expect(update.$push.keyEpochs.version).toBe(4);
    expect(update.$set.currentKeyVersion).toBe(4);
  });
});
