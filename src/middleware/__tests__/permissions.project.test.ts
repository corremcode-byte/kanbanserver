jest.mock('../../models', () => ({
  ProjectPermission: { findOne: jest.fn() },
  Project: { findById: jest.fn() },
  Task: { findById: jest.fn() },
}));

jest.mock('../../models/User', () => ({
  User: { findById: jest.fn() },
}));

import { Project } from '../../models';
import { User } from '../../models/User';
import { checkCanCreateProject, checkCanDeleteProject } from '../permissions';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';

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

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: USER_B,
    owners: [] as any[],
    managers: [] as any[],
    ...overrides,
  };
}

async function runCreate(body: any, user: any = { _id: USER_A }) {
  const res = makeRes();
  const next = jest.fn();
  await checkCanCreateProject({ user, body, params: {} } as any, res, next);
  return { res, next };
}

async function runDelete(params: any, user: any = { _id: USER_A }) {
  const res = makeRes();
  const next = jest.fn();
  await checkCanDeleteProject({ user, params, body: {} } as any, res, next);
  return { res, next };
}

beforeEach(() => {
  (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
  (Project.findById as jest.Mock).mockResolvedValue(makeProject());
});

describe('checkCanCreateProject — regular projects', () => {
  it('denies an unauthenticated request with 401', async () => {
    const { res, next } = await runCreate({}, null);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('allows a user with global canCreateProjects', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    const { next } = await runCreate({ name: 'New project' });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a user without canCreateProjects', async () => {
    const { res, next } = await runCreate({ name: 'New project' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to create projects");
  });

  it('denies when canCreateProjects is explicitly false', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: false } });

    const { res, next } = await runCreate({ name: 'New project' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('requires a strict boolean true — a truthy string does not grant access', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: 'true' } });

    const { res, next } = await runCreate({ name: 'New project' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('treats a missing user record as unprivileged', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await runCreate({ name: 'New project' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Note: role is deliberately not consulted — the production comment states
  // "Admin/manager role no longer bypasses permission checks."
  it('does not let an admin or superadmin role bypass the permission check', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ role: 'superadmin', permissions: {} });

    const { res, next } = await runCreate({ name: 'New project' }, { _id: USER_A, role: 'superadmin' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('fails closed with 500 when the user lookup throws', async () => {
    (User.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await runCreate({ name: 'New project' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Permission check failed');
  });
});

describe('checkCanCreateProject — adding members at creation time', () => {
  it('denies creating a project with members when addMembers is not granted', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    const { res, next } = await runCreate({ name: 'New project', members: [USER_B] });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain('permission to add members');
  });

  it('allows creating a project with members when addMembers is granted', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { canCreateProjects: true, modules: { projects: { addMembers: true } } },
    });

    const { next } = await runCreate({ name: 'New project', members: [USER_B] });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows creating a project with an empty members array without addMembers', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    const { next } = await runCreate({ name: 'New project', members: [] });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-array members value rather than treating it as members', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    const { next } = await runCreate({ name: 'New project', members: 'not-an-array' });

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('checkCanCreateProject — personal projects', () => {
  it('allows a personal project with global canCreatePersonalProjects', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { canCreatePersonalProjects: true },
    });

    const { next } = await runCreate({ name: 'Mine', isPersonal: true });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a personal project with the modules.projects.personalProjects flag', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { personalProjects: true } } },
    });

    const { next } = await runCreate({ name: 'Mine', isPersonal: true });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not let canCreateProjects stand in for personal-project permission', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    const { res, next } = await runCreate({ name: 'Mine', isPersonal: true });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain('personal projects');
  });

  it('treats the string "true" and numeric 1 as a personal-project request', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    for (const isPersonal of ['true', 'TRUE', 1, true]) {
      const { res, next } = await runCreate({ name: 'Mine', isPersonal });
      expect(next).not.toHaveBeenCalled();
      expect(payloadOf(res).message).toContain('personal projects');
    }
  });

  it('treats isPersonal false or absent as a regular project', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });

    expect((await runCreate({ name: 'Regular', isPersonal: false })).next).toHaveBeenCalledTimes(1);
    expect((await runCreate({ name: 'Regular' })).next).toHaveBeenCalledTimes(1);
  });

  it('denies a personal project when neither personal permission is granted', async () => {
    const { res, next } = await runCreate({ name: 'Mine', isPersonal: true });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('checkCanDeleteProject', () => {
  it('rejects an unauthenticated request', async () => {
    const { res, next } = await runDelete({ id: PROJECT_A }, null);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid request');
  });

  it('rejects a request with no project id', async () => {
    const { res, next } = await runDelete({});

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await runDelete({ id: PROJECT_A });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('allows the main owner to delete the project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));

    const { next } = await runDelete({ id: PROJECT_A });

    expect(next).toHaveBeenCalledTimes(1);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('recognises a populated ownerId document as ownership', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: { _id: { toString: () => USER_A } } })
    );

    const { next } = await runDelete({ id: PROJECT_A });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a co-owner with edit rights — only the main owner may delete', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_B, owners: [USER_A], coOwnerPermissions: { [USER_A]: 'edit' } })
    );

    const { res, next } = await runDelete({ id: PROJECT_A });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to delete this project");
  });

  it('denies a project manager', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_B, managers: [USER_A] })
    );

    const { res, next } = await runDelete({ id: PROJECT_A });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a user holding global canDeleteProjects on someone else’s project', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canDeleteProjects: true } });

    const { next } = await runDelete({ id: PROJECT_A });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not accept global canManageAllProjects as a delete permission', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageAllProjects: true } });

    const { res, next } = await runDelete({ id: PROJECT_A });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('fails closed with 500 when the project lookup throws', async () => {
    (Project.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await runDelete({ id: PROJECT_A });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
