/**
 * Notifications.
 *
 * Actor/target model: USER_A is the authenticated caller; USER_B owns the
 * notifications USER_A must not reach. NOTIF_B belongs to USER_B.
 */

jest.mock('../../models/Notification', () => ({
  Notification: {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndDelete: jest.fn(),
    countDocuments: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('../../socket', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })), emit: jest.fn() })),
}));

jest.mock('../../socket/socketHandlers', () => ({
  broadcastToUser: jest.fn(),
  broadcastToProject: jest.fn(),
}));

// Importing the controller pulls in the push service, which warns loudly about
// missing VAPID keys at module load. Stub it so test output stays clean.
jest.mock('../../services/pushNotificationService', () => ({
  pushNotificationService: { sendToUser: jest.fn(), sendNotification: jest.fn() },
}));

import { Notification } from '../../models/Notification';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadCount,
  getModuleCounts,
  getTaskNotificationStats,
  getTaskNotificationDetails,
} from '../notificationController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const NOTIF_B = '707f1f77bcf86cd7994390c2';
const TASK_ID = '807f1f77bcf86cd7994390d1';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return { user: { _id: USER_A }, params: {}, query: {}, body: {}, ...overrides } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** Notification.find(...).sort().skip().limit().lean() */
function mockFindChain(rows: any[]) {
  const chain: any = {};
  for (const method of ['sort', 'skip', 'limit', 'select', 'populate']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn().mockResolvedValue(rows);
  chain.then = (resolve: any) => Promise.resolve(rows).then(resolve);
  (Notification.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  mockFindChain([]);
  (Notification.countDocuments as jest.Mock).mockResolvedValue(0);
  (Notification.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
});

describe('getUserNotifications — caller scoping', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getUserNotifications(makeReq({ user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Notification.find).not.toHaveBeenCalled();
  });

  it('scopes the query to the authenticated user', async () => {
    await getUserNotifications(makeReq(), makeRes());

    expect((Notification.find as jest.Mock).mock.calls[0][0]).toEqual({ userId: USER_A });
  });

  it('ignores a userId supplied in the query string', async () => {
    // Actor tries to read USER_B's notifications via ?userId=.
    await getUserNotifications(makeReq({ query: { userId: USER_B } }), makeRes());

    const filter = (Notification.find as jest.Mock).mock.calls[0][0];
    expect(filter).toEqual({ userId: USER_A });
    expect(JSON.stringify(filter)).not.toContain(USER_B);
  });

  it('ignores a userId supplied in the body', async () => {
    await getUserNotifications(makeReq({ body: { userId: USER_B } }), makeRes());

    expect((Notification.find as jest.Mock).mock.calls[0][0]).toEqual({ userId: USER_A });
  });

  it('applies the unreadOnly filter when requested', async () => {
    await getUserNotifications(makeReq({ query: { unreadOnly: 'true' } }), makeRes());

    expect((Notification.find as jest.Mock).mock.calls[0][0]).toEqual({ userId: USER_A, read: false });
  });

  it('treats any value other than the string "true" as unfiltered', async () => {
    await getUserNotifications(makeReq({ query: { unreadOnly: true } }), makeRes());

    expect((Notification.find as jest.Mock).mock.calls[0][0]).toEqual({ userId: USER_A });
  });

  it('paginates with the supplied page and limit', async () => {
    const chain = mockFindChain([]);

    await getUserNotifications(makeReq({ query: { page: '3', limit: '10' } }), makeRes());

    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it('defaults to page 1 with a limit of 20', async () => {
    const chain = mockFindChain([]);

    await getUserNotifications(makeReq(), makeRes());

    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it('returns the documented pagination envelope', async () => {
    (Notification.countDocuments as jest.Mock).mockResolvedValue(42);
    const res = makeRes();

    await getUserNotifications(makeReq({ query: { page: '2', limit: '20' } }), res);

    expect(payloadOf(res).data.pagination).toEqual({ page: 2, limit: 20, total: 42, pages: 3 });
  });

  it('counts unread notifications for the caller only', async () => {
    await getUserNotifications(makeReq(), makeRes());

    expect(Notification.countDocuments).toHaveBeenCalledWith({ userId: USER_A, read: false });
  });

  it('returns 500 when the query throws', async () => {
    (Notification.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getUserNotifications(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('markNotificationAsRead — ownership', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await markNotificationAsRead(makeReq({ user: null, params: { notificationId: NOTIF_B } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Notification.findOne).not.toHaveBeenCalled();
  });

  it('scopes the lookup to both the notification id and the caller', async () => {
    (Notification.findOne as jest.Mock).mockResolvedValue(null);

    await markNotificationAsRead(makeReq({ params: { notificationId: NOTIF_B } }), makeRes());

    expect(Notification.findOne).toHaveBeenCalledWith({ _id: NOTIF_B, userId: USER_A });
  });

  it('returns 404 rather than 403 when the notification belongs to another user', async () => {
    // The compound filter simply fails to match, so the actor cannot even learn
    // that the notification exists.
    (Notification.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await markNotificationAsRead(makeReq({ params: { notificationId: NOTIF_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Notification not found');
  });

  it('marks the caller’s own notification read and stamps readAt', async () => {
    const doc: any = { _id: 'own', read: false, save: jest.fn().mockResolvedValue(undefined) };
    (Notification.findOne as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await markNotificationAsRead(makeReq({ params: { notificationId: 'own' } }), res);

    expect(doc.read).toBe(true);
    expect(doc.readAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ignores a userId supplied in the body when scoping the lookup', async () => {
    (Notification.findOne as jest.Mock).mockResolvedValue(null);

    await markNotificationAsRead(
      makeReq({ params: { notificationId: NOTIF_B }, body: { userId: USER_B } }),
      makeRes()
    );

    expect(Notification.findOne).toHaveBeenCalledWith({ _id: NOTIF_B, userId: USER_A });
  });

  it('returns 500 when the save fails', async () => {
    (Notification.findOne as jest.Mock).mockResolvedValue({
      save: jest.fn().mockRejectedValue(new Error('write failed')),
    });
    const res = makeRes();

    await markNotificationAsRead(makeReq({ params: { notificationId: 'own' } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('markAllNotificationsAsRead', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await markAllNotificationsAsRead(makeReq({ user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Notification.updateMany).not.toHaveBeenCalled();
  });

  it('updates only the caller’s unread notifications', async () => {
    await markAllNotificationsAsRead(makeReq(), makeRes());

    expect(Notification.updateMany).toHaveBeenCalledWith(
      { userId: USER_A, read: false },
      expect.objectContaining({ read: true })
    );
  });

  it('cannot be aimed at another user through the body', async () => {
    await markAllNotificationsAsRead(makeReq({ body: { userId: USER_B } }), makeRes());

    const filter = (Notification.updateMany as jest.Mock).mock.calls[0][0];
    expect(filter.userId).toBe(USER_A);
    expect(JSON.stringify(filter)).not.toContain(USER_B);
  });

  it('returns 500 when the bulk update throws', async () => {
    (Notification.updateMany as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await markAllNotificationsAsRead(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteNotification — ownership', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await deleteNotification(makeReq({ user: null, params: { notificationId: NOTIF_B } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Notification.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('scopes the delete to the caller, so another user’s notification is untouched', async () => {
    (Notification.findOneAndDelete as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteNotification(makeReq({ params: { notificationId: NOTIF_B } }), res);

    expect(Notification.findOneAndDelete).toHaveBeenCalledWith({ _id: NOTIF_B, userId: USER_A });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deletes the caller’s own notification', async () => {
    (Notification.findOneAndDelete as jest.Mock).mockResolvedValue({ _id: 'own' });
    const res = makeRes();

    await deleteNotification(makeReq({ params: { notificationId: 'own' } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe('Notification deleted successfully');
  });

  it('returns 500 when the delete throws', async () => {
    (Notification.findOneAndDelete as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await deleteNotification(makeReq({ params: { notificationId: 'own' } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getUnreadCount and getModuleCounts', () => {
  it('both reject an unauthenticated request', async () => {
    for (const handler of [getUnreadCount, getModuleCounts]) {
      const res = makeRes();
      await handler(makeReq({ user: null }), res);
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('counts unread notifications for the caller only', async () => {
    (Notification.countDocuments as jest.Mock).mockResolvedValue(7);
    const res = makeRes();

    await getUnreadCount(makeReq(), res);

    expect(Notification.countDocuments).toHaveBeenCalledWith({ userId: USER_A, read: false });
    expect(payloadOf(res).data).toEqual({ unreadCount: 7 });
  });

  it('module counts are scoped to the caller’s unread notifications', async () => {
    mockFindChain([]);

    await getModuleCounts(makeReq(), makeRes());

    expect((Notification.find as jest.Mock).mock.calls[0][0]).toEqual({ userId: USER_A, read: false });
  });

  it('groups unread notifications into module buckets with ids', async () => {
    mockFindChain([
      { _id: 'n1', type: 'task_assigned' },
      { _id: 'n2', type: 'task_assigned' },
    ]);
    const res = makeRes();

    await getModuleCounts(makeReq(), res);

    const { counts, ids } = payloadOf(res).data;
    const moduleKey = Object.keys(counts)[0];
    expect(counts[moduleKey]).toBe(2);
    expect(ids[moduleKey]).toEqual(['n1', 'n2']);
  });

  it('excludes task_chat_message ids from the bulk-mark list while still counting them', async () => {
    mockFindChain([{ _id: 'n1', type: 'task_chat_message' }]);
    const res = makeRes();

    await getModuleCounts(makeReq(), res);

    const { counts, ids } = payloadOf(res).data;
    const moduleKey = Object.keys(counts)[0];
    expect(counts[moduleKey]).toBe(1);
    expect(ids[moduleKey]).toBeUndefined();
  });

  it('ignores notification types that map to no module', async () => {
    mockFindChain([{ _id: 'n1', type: 'some_unmapped_type' }]);
    const res = makeRes();

    await getModuleCounts(makeReq(), res);

    expect(payloadOf(res).data.counts).toEqual({});
  });
});

describe('task-scoped notification endpoints — cross-user exposure', () => {
  it('rejects a malformed task id for stats', async () => {
    const res = makeRes();

    await getTaskNotificationStats(makeReq({ params: { taskId: 'not-an-objectid' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid task ID');
    expect(Notification.countDocuments).not.toHaveBeenCalled();
  });

  it('rejects a malformed task id for details', async () => {
    const res = makeRes();

    await getTaskNotificationDetails(makeReq({ params: { taskId: 'not-an-objectid' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Notification.find).not.toHaveBeenCalled();
  });

  // SECURITY FINDING (documented, NOT fixed): these two task-scoped endpoints
  // filter only on metadata.taskId. They apply no userId scoping and no project
  // membership check, so any authenticated user can read notification records
  // belonging to every recipient of any task — including, for details, each
  // recipient's displayName and email.
  it('counts notifications for a task across ALL recipients, not just the caller', async () => {
    (Notification.countDocuments as jest.Mock).mockResolvedValue(5);
    const res = makeRes();

    await getTaskNotificationStats(makeReq({ params: { taskId: TASK_ID } }), res);

    const filter = (Notification.countDocuments as jest.Mock).mock.calls[0][0];
    expect(Object.keys(filter)).toEqual(['metadata.taskId']);
    expect(JSON.stringify(filter)).not.toContain(USER_A);
    expect(payloadOf(res).data).toEqual({ total: 5, read: 5, unread: 0 });
  });

  it('returns other users’ notification records, populated with name and email', async () => {
    const chain = mockFindChain([
      { _id: 'n1', userId: { _id: USER_B, displayName: 'User B', email: 'userb@example.com' } },
    ]);
    const res = makeRes();

    await getTaskNotificationDetails(makeReq({ params: { taskId: TASK_ID } }), res);

    const filter = (Notification.find as jest.Mock).mock.calls[0][0];
    expect(Object.keys(filter)).toEqual(['metadata.taskId']);
    expect(chain.populate).toHaveBeenCalledWith('userId', 'displayName email');
    expect(payloadOf(res).data[0].userId.email).toBe('userb@example.com');
  });

  it('performs no project-membership check before returning task notification data', async () => {
    mockFindChain([]);

    await getTaskNotificationDetails(makeReq({ params: { taskId: TASK_ID } }), makeRes());

    // Only the Notification collection is consulted — no Task or Project lookup.
    expect(Notification.find).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the stats query throws', async () => {
    (Notification.countDocuments as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await getTaskNotificationStats(makeReq({ params: { taskId: TASK_ID } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
