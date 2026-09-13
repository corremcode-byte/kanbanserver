/**
 * Search: GET /api/search
 *
 * Actor/target model: USER_A is the authenticated caller and a member of
 * PROJECT_A. PROJECT_B and its tasks belong to USER_B and must never surface.
 */

jest.mock('../../models/Task', () => {
  const Task: any = { find: jest.fn() };
  return { __esModule: true, default: Task, Task };
});

jest.mock('../../models/Project', () => {
  const Project: any = { find: jest.fn() };
  return { __esModule: true, default: Project, Project };
});

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('../../utils/fieldEncryption', () => ({
  decryptTaskFields: jest.fn((t: any) => t),
  decryptProjectFields: jest.fn((p: any) => p),
}));

import Task from '../../models/Task';
import Project from '../../models/Project';
import { search } from '../searchController';

const USER_A = '507f1f77bcf86cd799439011';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(query: any = {}, user: any = { _id: USER_A, email: 'a@example.com' }) {
  return { query, params: {}, body: {}, user } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    name: 'Alpha project',
    description: 'The alpha initiative',
    ...overrides,
  };
}

function makeTask(overrides: Record<string, any> = {}) {
  return {
    _id: 't1',
    title: 'Alpha task',
    description: 'task detail',
    projectId: { _id: PROJECT_A, name: 'Alpha project' },
    ...overrides,
  };
}

/** Project.find(...).select(...) resolving to the caller's projects. */
function mockProjectFind(projects: any[]) {
  (Project.find as jest.Mock).mockReturnValue({
    select: jest.fn().mockResolvedValue(projects),
  });
}

/** Task.find(...).populate()...sort().lean() */
function mockTaskFind(tasks: any[]) {
  const chain: any = {};
  for (const method of ['populate', 'sort']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn().mockResolvedValue(tasks);
  (Task.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  mockProjectFind([makeProject()]);
  mockTaskFind([]);
});

describe('search — input validation', () => {
  it('requires a query string', async () => {
    const res = makeRes();

    await search(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Search query is required');
    expect(Project.find).not.toHaveBeenCalled();
  });

  it('rejects an empty query string', async () => {
    const res = makeRes();

    await search(makeReq({ q: '' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Project.find).not.toHaveBeenCalled();
  });

  it('rejects a non-string query such as a repeated parameter', async () => {
    const res = makeRes();

    await search(makeReq({ q: ['alpha', 'beta'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Project.find).not.toHaveBeenCalled();
  });

  it('returns 500 when the project lookup throws', async () => {
    (Project.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Failed to perform search');
  });
});

describe('search — project scoping', () => {
  it('restricts the project set to ones the caller owns, manages or is a member of', async () => {
    await search(makeReq({ q: 'alpha' }), makeRes());

    expect(Project.find).toHaveBeenCalledWith({
      $or: [{ ownerId: USER_A }, { members: USER_A }, { managers: USER_A }],
    });
  });

  it('restricts the task search to those same projects', async () => {
    mockProjectFind([makeProject()]);

    await search(makeReq({ q: 'alpha' }), makeRes());

    const filter = (Task.find as jest.Mock).mock.calls[0][0];
    expect(filter.projectId.$in).toEqual([PROJECT_A]);
  });

  it('searches no tasks at all when the caller belongs to no project', async () => {
    mockProjectFind([]);
    mockTaskFind([]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect((Task.find as jest.Mock).mock.calls[0][0].projectId.$in).toEqual([]);
    expect(payloadOf(res).data.tasks).toEqual([]);
    expect(payloadOf(res).data.projects).toEqual([]);
  });

  it('cannot be widened by a projectId supplied in the query string', async () => {
    // Actor attempts to force PROJECT_B into scope.
    await search(makeReq({ q: 'alpha', projectId: PROJECT_B }), makeRes());

    const projectFilter = (Project.find as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(projectFilter)).not.toContain(PROJECT_B);
    expect((Task.find as jest.Mock).mock.calls[0][0].projectId.$in).not.toContain(PROJECT_B);
  });

  it('cannot be redirected to another user by a userId in the query string', async () => {
    await search(makeReq({ q: 'alpha', userId: '507f1f77bcf86cd799439099' }), makeRes());

    const filter = (Project.find as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(filter)).toContain(USER_A);
    expect(JSON.stringify(filter)).not.toContain('507f1f77bcf86cd799439099');
  });
});

describe('search — matching behaviour', () => {
  it('matches projects by name, case-insensitively', async () => {
    mockProjectFind([makeProject({ name: 'Alpha project' })]);
    const res = makeRes();

    await search(makeReq({ q: 'ALPHA' }), res);

    expect(payloadOf(res).data.projects).toHaveLength(1);
  });

  it('matches projects by description', async () => {
    mockProjectFind([makeProject({ name: 'Zeta', description: 'the alpha initiative' })]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(payloadOf(res).data.projects).toHaveLength(1);
  });

  it('excludes projects that match neither name nor description', async () => {
    mockProjectFind([makeProject({ name: 'Zeta', description: 'unrelated' })]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(payloadOf(res).data.projects).toEqual([]);
  });

  it('matches tasks by title and by description', async () => {
    mockTaskFind([
      makeTask({ _id: 't1', title: 'Alpha task', description: 'x' }),
      makeTask({ _id: 't2', title: 'Other', description: 'mentions alpha' }),
      makeTask({ _id: 't3', title: 'Unrelated', description: 'nothing' }),
    ]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(payloadOf(res).data.tasks.map((t: any) => t._id)).toEqual(['t1', 't2']);
  });

  it('tolerates tasks with no description', async () => {
    mockTaskFind([makeTask({ title: 'Alpha task', description: undefined })]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(payloadOf(res).data.tasks).toHaveLength(1);
  });

  it('caps tasks at 20 and projects at 10 results', async () => {
    mockTaskFind(Array.from({ length: 30 }, (_, i) => makeTask({ _id: `t${i}`, title: 'alpha' })));
    mockProjectFind(
      Array.from({ length: 15 }, (_, i) => makeProject({ _id: `p${i}`, name: 'alpha' }))
    );
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(payloadOf(res).data.tasks).toHaveLength(20);
    expect(payloadOf(res).data.projects).toHaveLength(10);
  });

  it('returns both collections in the documented envelope', async () => {
    const res = makeRes();

    await search(makeReq({ q: 'alpha' }), res);

    expect(Object.keys(payloadOf(res).data).sort()).toEqual(['projects', 'tasks']);
  });
});

describe('search — query string treated as a regular expression', () => {
  // The query is passed straight to `new RegExp(query, 'i')` with no escaping.
  // Documented, not fixed: metacharacters are interpreted rather than matched
  // literally, and an invalid pattern throws into the 500 branch.
  it('interprets regex metacharacters instead of matching them literally', async () => {
    mockTaskFind([
      makeTask({ _id: 't1', title: 'alpha', description: 'x' }),
      makeTask({ _id: 't2', title: 'beta', description: 'x' }),
    ]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha|beta' }), res);

    // A literal search for "alpha|beta" would match neither task.
    expect(payloadOf(res).data.tasks).toHaveLength(2);
  });

  it('matches every task when given a wildcard pattern', async () => {
    mockTaskFind([makeTask({ _id: 't1' }), makeTask({ _id: 't2' })]);
    const res = makeRes();

    await search(makeReq({ q: '.*' }), res);

    expect(payloadOf(res).data.tasks).toHaveLength(2);
  });

  it('returns 500 for a syntactically invalid regular expression', async () => {
    const res = makeRes();

    await search(makeReq({ q: '[unclosed' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Failed to perform search');
  });

  it('still applies plain substring matching to projects, not the regex', async () => {
    // Projects use String.includes(), so metacharacters are literal there.
    mockProjectFind([makeProject({ name: 'Alpha project', description: '' })]);
    const res = makeRes();

    await search(makeReq({ q: 'alpha|beta' }), res);

    expect(payloadOf(res).data.projects).toEqual([]);
  });
});
