/**
 * Audit log retrieval: GET /api/audit
 *
 * Actor/target model: USER_A is the authenticated caller; USER_B and PROJECT_B
 * belong to an unrelated tenant/project that USER_A has no access to.
 */

jest.mock('../../models/AuditLog', () => ({
  AuditLog: { find: jest.fn(), deleteMany: jest.fn(), countDocuments: jest.fn() },
}));

jest.mock('../../models/User', () => ({
  User: { findById: jest.fn(), find: jest.fn() },
}));

import { AuditLog } from '../../models/AuditLog';
import { User } from '../../models/User';
import { getAuditLogs } from '../auditController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

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

/** Actor defaults to USER_A, an ordinary member. */
function makeReq(query: any = {}, user: any = { _id: USER_A, role: 'member' }) {
  return { query, params: {}, body: {}, user } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeLog(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => 'log-1' },
    createdAt: new Date('2026-01-01'),
    action: 'task_created',
    entityType: 'task',
    entityId: { toString: () => 'task-1' },
    userId: { _id: { toString: () => USER_B }, displayName: 'User B', email: 'userb@example.com' },
    projectId: { _id: { toString: () => PROJECT_B }, name: 'Project B' },
    metadata: { taskTitle: 'Some task' },
    ...overrides,
  };
}

/** AuditLog.find(...).populate().populate().sort().limit().lean() */
function mockAuditFind(logs: any[]) {
  const chain: any = {};
  for (const method of ['populate', 'sort', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn().mockResolvedValue(logs);
  (AuditLog.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

/** User.findById(...).select(...).lean() — the active/superadmin filter. */
function mockUserLookup(user: any) {
  (User.findById as jest.Mock).mockReturnValue({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(user) })),
  });
}

beforeEach(() => {
  mockAuditFind([]);
  mockUserLookup({ isActive: true, role: 'member' });
});

describe('getAuditLogs — query construction from client input', () => {
  it('applies no filter at all when no query parameters are supplied', async () => {
    await getAuditLogs(makeReq(), makeRes());

    expect(AuditLog.find).toHaveBeenCalledWith({});
  });

  it('filters by a client-supplied projectId verbatim', async () => {
    await getAuditLogs(makeReq({ projectId: PROJECT_B }), makeRes());

    expect(AuditLog.find).toHaveBeenCalledWith({ projectId: PROJECT_B });
  });

  it('filters by a client-supplied userId verbatim', async () => {
    await getAuditLogs(makeReq({ userId: USER_B }), makeRes());

    expect(AuditLog.find).toHaveBeenCalledWith({ userId: USER_B });
  });

  it('translates an eventType into the stored action name', async () => {
    await getAuditLogs(makeReq({ eventType: 'task.created' }), makeRes());

    expect(AuditLog.find).toHaveBeenCalledWith({ action: 'task_created' });
  });

  it('builds a date range from startDate and endDate', async () => {
    await getAuditLogs(
      makeReq({ startDate: '2026-01-01', endDate: '2026-02-01' }),
      makeRes()
    );

    const query = (AuditLog.find as jest.Mock).mock.calls[0][0];
    expect(query.createdAt.$gte).toBeInstanceOf(Date);
    expect(query.createdAt.$lte).toBeInstanceOf(Date);
  });

  it('combines several filters into a single query', async () => {
    await getAuditLogs(
      makeReq({ projectId: PROJECT_A, userId: USER_A, eventType: 'task.deleted' }),
      makeRes()
    );

    expect(AuditLog.find).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      userId: USER_A,
      action: 'task_deleted',
    });
  });

  it('defaults the limit to 50 and over-fetches to allow post-filtering', async () => {
    const chain = mockAuditFind([]);

    await getAuditLogs(makeReq(), makeRes());

    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  it('caps an excessive limit at 10000', async () => {
    const chain = mockAuditFind([]);

    await getAuditLogs(makeReq({ limit: '999999' }), makeRes());

    expect(chain.limit).toHaveBeenCalledWith(20000); // parsedLimit(10000) * 2
  });

  it('falls back to 50 for a non-numeric limit', async () => {
    const chain = mockAuditFind([]);

    await getAuditLogs(makeReq({ limit: 'not-a-number' }), makeRes());

    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  it('returns 500 when the query throws', async () => {
    (AuditLog.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).success).toBe(false);
  });

  // The error branch echoes error.message to the client.
  it('includes the raw error message in the 500 body', async () => {
    (AuditLog.find as jest.Mock).mockImplementation(() => {
      throw new Error('E11000 duplicate key on audit-shard-3');
    });
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).error).toContain('audit-shard-3');
  });
});

describe('getAuditLogs — result filtering and shape', () => {
  it('excludes logs whose actor is inactive', async () => {
    mockAuditFind([makeLog()]);
    mockUserLookup({ isActive: false, role: 'member' });
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).data).toHaveLength(0);
  });

  it('excludes logs whose actor is a superadmin', async () => {
    mockAuditFind([makeLog()]);
    mockUserLookup({ isActive: true, role: 'superadmin' });
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).data).toHaveLength(0);
  });

  it('excludes logs whose actor no longer exists', async () => {
    mockAuditFind([makeLog()]);
    mockUserLookup(null);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).data).toHaveLength(0);
  });

  it('drops logs that carry no userId at all', async () => {
    mockAuditFind([makeLog({ userId: null })]);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).data).toHaveLength(0);
  });

  it('stops collecting once the requested limit is reached', async () => {
    mockAuditFind([makeLog(), makeLog(), makeLog(), makeLog()]);
    const res = makeRes();

    await getAuditLogs(makeReq({ limit: '2' }), res);

    expect(payloadOf(res).data).toHaveLength(2);
  });

  it('returns each entry with the documented transformed shape', async () => {
    mockAuditFind([makeLog()]);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    const entry = payloadOf(res).data[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['details', 'event', 'id', 'metadata', 'resource', 'source', 'timestamp', 'user'].sort()
    );
    expect(entry.event).toBe('task.created');
  });

  it('echoes the applied filters back in the response meta', async () => {
    mockAuditFind([]);
    const res = makeRes();

    await getAuditLogs(makeReq({ projectId: PROJECT_B, userId: USER_B }), res);

    expect(payloadOf(res).meta.filters.projectId).toBe(PROJECT_B);
    expect(payloadOf(res).meta.filters.userId).toBe(USER_B);
  });

  it('falls back to placeholder identity text when the actor has no name or email', async () => {
    mockAuditFind([makeLog({ userId: { _id: { toString: () => USER_B } } })]);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    const user = payloadOf(res).data[0].user;
    expect(user.name).toBe('Unknown User');
    expect(user.email).toBe('unknown@email.com');
  });
});

describe('getAuditLogs — tenant/project isolation (IDOR regression)', () => {
  // SECURITY FINDING (documented, NOT fixed): getAuditLogs never reads
  // req.user. The Mongo query is assembled entirely from client-supplied query
  // parameters, so there is no scoping to the caller's projects or account.
  // Any authenticated user retrieves the whole tenant's audit trail, and can
  // aim it at any project or any other user with ?projectId= / ?userId=.
  //
  // Locked in deliberately: a future fix that adds scoping will fail these.
  it('never consults the authenticated caller when building the query', async () => {
    const req = makeReq({}, { _id: USER_A, role: 'member' });

    await getAuditLogs(req, makeRes());

    const query = (AuditLog.find as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(query)).not.toContain(USER_A);
    expect(query).toEqual({});
  });

  it('returns another project’s audit entries to a non-member', async () => {
    // USER_A has no relationship with PROJECT_B.
    mockAuditFind([makeLog({ projectId: { _id: { toString: () => PROJECT_B }, name: 'Project B' } })]);
    const res = makeRes();

    await getAuditLogs(makeReq({ projectId: PROJECT_B }, { _id: USER_A, role: 'member' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data).toHaveLength(1);
    expect(payloadOf(res).data[0].metadata.payload.projectId).toBe(PROJECT_B);
  });

  it('returns another user’s activity trail when filtered by their id', async () => {
    mockAuditFind([makeLog()]);
    const res = makeRes();

    await getAuditLogs(makeReq({ userId: USER_B }, { _id: USER_A, role: 'member' }), res);

    expect(payloadOf(res).data).toHaveLength(1);
    expect(payloadOf(res).data[0].user.id).toBe(USER_B);
  });

  it('exposes other users’ email addresses in the audit response', async () => {
    mockAuditFind([makeLog()]);
    const res = makeRes();

    await getAuditLogs(makeReq({}, { _id: USER_A, role: 'member' }), res);

    expect(payloadOf(res).data[0].user.email).toBe('userb@example.com');
  });

  it('returns identical results for a member and for an admin caller', async () => {
    mockAuditFind([makeLog()]);
    const member = makeRes();
    await getAuditLogs(makeReq({}, { _id: USER_A, role: 'member' }), member);

    mockAuditFind([makeLog()]);
    const admin = makeRes();
    await getAuditLogs(makeReq({}, { _id: USER_A, role: 'admin' }), admin);

    expect(payloadOf(member).data).toEqual(payloadOf(admin).data);
  });

  it('includes system-level logs that have no project when no projectId filter is given', async () => {
    mockAuditFind([makeLog({ action: 'user_login', projectId: null, metadata: {} })]);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    expect(payloadOf(res).data).toHaveLength(1);
    expect(payloadOf(res).data[0].event).toBe('user.login');
  });

  it('surfaces stored metadata verbatim in the payload', async () => {
    mockAuditFind([
      makeLog({ metadata: { taskTitle: 'Confidential task', oldValue: 'a', newValue: 'b' } }),
    ]);
    const res = makeRes();

    await getAuditLogs(makeReq(), res);

    const entry = payloadOf(res).data[0];
    expect(entry.metadata.payload.taskTitle).toBe('Confidential task');
    expect(entry.metadata.before).toEqual({ value: 'a' });
    expect(entry.metadata.after).toEqual({ value: 'b' });
  });
});
