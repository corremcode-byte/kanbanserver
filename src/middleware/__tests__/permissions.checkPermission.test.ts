jest.mock('../../models', () => ({
  ProjectPermission: { findOne: jest.fn() },
  Project: { findById: jest.fn() },
  Task: { findById: jest.fn() },
}));

// checkPermission resolves the User model through a dynamic import().
jest.mock('../../models/User', () => ({
  User: { findById: jest.fn() },
}));

import { ProjectPermission, Project, Task } from '../../models';
import { User } from '../../models/User';
import { checkPermission } from '../permissions';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';
const TASK_IN_B = '707f1f77bcf86cd7994390c3';

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
    user: { _id: USER_A },
    params: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** A project owned by USER_B unless told otherwise. */
function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: USER_B,
    owners: [] as any[],
    members: [] as any[],
    managers: [] as any[],
    coOwnerPermissions: undefined as any,
    ...overrides,
  };
}

/** A ProjectPermission record with every flag false unless overridden. */
function makePermissionRecord(permissions: Record<string, any> = {}) {
  return {
    projectId: PROJECT_A,
    userId: USER_A,
    role: 'member',
    permissions: {
      canCreateTasks: false,
      canEditTasks: false,
      canDeleteTasks: false,
      canAssignTasks: false,
      canEditProject: false,
      canManageMembers: false,
      canViewAllTasks: false,
      canManagePermissions: false,
      canCreateChatGroups: false,
      canDeleteChatGroups: false,
      ...permissions,
    },
  };
}

/** Runs the middleware and returns { res, next }. */
async function run(permission: any, req: any) {
  const res = makeRes();
  const next = jest.fn();
  await checkPermission(permission)(req, res, next);
  return { res, next };
}

beforeEach(() => {
  (Task.findById as jest.Mock).mockResolvedValue(null);
  (Project.findById as jest.Mock).mockResolvedValue(makeProject());
  (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
  (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
});

describe('checkPermission — authentication and project resolution', () => {
  it('denies an unauthenticated request with 401', async () => {
    const { res, next } = await run('canEditProject', makeReq({ user: undefined }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(payloadOf(res).message).toBe('Unauthorized');
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('resolves the project from params.projectId', async () => {
    await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
  });

  it('resolves the project from params.id when projectId is absent', async () => {
    await run('canEditProject', makeReq({ params: { id: PROJECT_A } }));

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
  });

  it('falls back to body.projectId when no route param carries one', async () => {
    await run('canEditProject', makeReq({ body: { projectId: PROJECT_A } }));

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
  });

  it('prefers the route param over a conflicting body projectId', async () => {
    await run(
      'canEditProject',
      makeReq({ params: { projectId: PROJECT_A }, body: { projectId: PROJECT_B } })
    );

    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
    expect(Project.findById).not.toHaveBeenCalledWith(PROJECT_B);
  });

  it('rejects with 400 when no project id can be resolved', async () => {
    const { res, next } = await run('canEditProject', makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Project ID not found');
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Project not found');
  });

  it('re-resolves a task id supplied as the project id to that task’s own project', async () => {
    (Task.findById as jest.Mock).mockResolvedValue({ _id: TASK_IN_B, projectId: PROJECT_B });

    await run('canEditProject', makeReq({ params: { projectId: TASK_IN_B } }));

    // The middleware authorises against the task's real project, not the id passed in.
    expect(Project.findById).toHaveBeenCalledWith(PROJECT_B);
  });

  it('fails closed with 500 when the project lookup throws', async () => {
    (Project.findById as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).message).toBe('Permission check failed');
  });
});

describe('checkPermission — standalone task creation (no project)', () => {
  it('allows creating a standalone task with global canCreateTasks', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateTasks: true } });

    const { res, next } = await run('canCreateTasks', makeReq());

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows creating a standalone task with global canManageAllProjects', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageAllProjects: true } });

    const { next } = await run('canCreateTasks', makeReq());

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a standalone task when the user holds neither global permission', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canEditTasks: true } });

    const { res, next } = await run('canCreateTasks', makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('offers no standalone escape hatch for permissions other than canCreateTasks', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageAllProjects: true } });

    const { res, next } = await run('canEditProject', makeReq());

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('checkPermission — project ownership', () => {
  it('allows the main owner every project permission', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));

    for (const permission of ['canEditProject', 'canManagePermissions', 'canDeleteTasks', 'canViewAllTasks']) {
      const { res, next } = await run(permission, makeReq({ params: { projectId: PROJECT_A } }));
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('recognises ownership when ownerId arrives populated as a document', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: { _id: { toString: () => USER_A }, email: 'owner@example.com' } })
    );

    const { next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not treat a non-owner as owner, falling through to the permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_B }));

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(ProjectPermission.findOne).toHaveBeenCalled();
  });

  it('derives ownership from the authenticated user, not from a body-supplied ownerId', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_B }));

    const { res, next } = await run(
      'canEditProject',
      makeReq({ params: { projectId: PROJECT_A }, body: { ownerId: USER_A, userId: USER_A } })
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('checkPermission — co-owner permission levels', () => {
  it('allows an edit co-owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'edit' } })
    );

    const { next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reads co-owner levels from a Mongoose Map as well as a plain object', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: new Map([[USER_A, 'edit']]) })
    );

    const { next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a view-only co-owner, falling through to the project permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('a view-only co-owner still gets a permission it was granted at project level', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditProject: true })
    );

    const { next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  // SECURITY FINDING (documented, not fixed): the co-owner level defaults to
  // 'edit' both when the map has no entry for the user and when the project has
  // no coOwnerPermissions map at all. Being listed in owners[] therefore grants
  // full edit rights unless someone explicitly wrote 'view' — the check
  // fails open rather than closed.
  it('defaults an unlisted co-owner to full edit rights (fails open)', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_B]: 'view' } })
    );

    const { next } = await run('canManagePermissions', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('defaults to full edit rights when the project has no coOwnerPermissions map at all', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: undefined })
    );

    const { next } = await run('canManagePermissions', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not treat a co-owner of another project as a co-owner here', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_B], coOwnerPermissions: { [USER_B]: 'edit' } })
    );

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('checkPermission — project managers', () => {
  // FINDING (documented, not fixed): checkPermission never inspects
  // project.managers. Being a project manager confers nothing here, even though
  // projectsController.isProjectManager treats managers as privileged for list
  // and project-read operations. The two authorisation models disagree.
  it('grants a user in managers[] nothing — managers are not consulted', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ managers: [USER_A], members: [USER_A] })
    );

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('a manager who also holds a project permission record is allowed by that record alone', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ managers: [USER_A] }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditProject: true })
    );

    const { next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('checkPermission — global permissions', () => {
  it('allows every project permission for a user with global canManageAllProjects', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageAllProjects: true } });

    for (const permission of ['canEditProject', 'canManagePermissions', 'canDeleteTasks']) {
      const { next } = await run(permission, makeReq({ params: { projectId: PROJECT_A } }));
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(ProjectPermission.findOne).not.toHaveBeenCalled();
  });

  it('honours global canCreateTasks and canAssignTasks for their own permission only', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { canCreateTasks: true, canAssignTasks: true },
    });

    expect((await run('canCreateTasks', makeReq({ params: { projectId: PROJECT_A } }))).next)
      .toHaveBeenCalledTimes(1);
    expect((await run('canAssignTasks', makeReq({ params: { projectId: PROJECT_A } }))).next)
      .toHaveBeenCalledTimes(1);
  });

  it('does not let global canCreateTasks leak into other permissions', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateTasks: true } });

    const { res, next } = await run('canDeleteTasks', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('treats a nonexistent user record as unprivileged rather than erroring', async () => {
    (User.findById as jest.Mock).mockResolvedValue(null);

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('checkPermission — canManageMembers precedence', () => {
  it('allows a user whose global modules.projects.manageMembers is true', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: true } } },
    });

    const { next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies when global manageMembers is explicitly false', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: false } } },
    });

    const { res, next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to manage members");
  });

  it('denies when global manageMembers is undefined — it must be granted explicitly', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });

    const { res, next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toContain('must be granted in your user permissions');
  });

  // FINDING (documented, not fixed): a project-level canManageMembers grant is
  // unreachable. Every canManageMembers path returns before the
  // ProjectPermission lookup, so the flag stored on the permission record — and
  // surfaced in the permissions UI — has no effect whatsoever.
  it('never consults the project permission record, making a project-level grant dead', async () => {
    (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canManageMembers: true })
    );

    const { res, next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(ProjectPermission.findOne).not.toHaveBeenCalled();
  });

  // FINDING (documented, not fixed): the explicit-false deny sits *after* the
  // ownership and canManageAllProjects checks, so a negative permission cannot
  // actually override those. An administrator who sets manageMembers=false on a
  // project owner achieves nothing.
  it('lets the main owner manage members despite an explicit global false', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: false } } },
    });

    const { next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets an edit co-owner manage members despite an explicit global false', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'edit' } })
    );
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: false } } },
    });

    const { next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets global canManageAllProjects override an explicit manageMembers false', async () => {
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: {
        canManageAllProjects: true,
        modules: { projects: { manageMembers: false } },
      },
    });

    const { next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does apply the explicit false to a view-only co-owner, who has no bypass', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: false } } },
    });

    const { res, next } = await run('canManageMembers', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('checkPermission — project permission records', () => {
  it('denies a user with no permission record for the project', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('allows when the record grants the requested permission', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canViewAllTasks: true })
    );

    const { next } = await run('canViewAllTasks', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies when the record sets the requested permission to false', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canEditProject: false, canViewAllTasks: true })
    );

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe("You don't have permission to editproject");
  });

  it('evaluates each permission field independently on the same record', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionRecord({ canCreateTasks: true, canDeleteTasks: false })
    );

    expect((await run('canCreateTasks', makeReq({ params: { projectId: PROJECT_A } }))).next)
      .toHaveBeenCalledTimes(1);
    expect((await run('canDeleteTasks', makeReq({ params: { projectId: PROJECT_A } }))).next)
      .not.toHaveBeenCalled();
  });

  it('scopes the permission lookup to both the project and the authenticated user', async () => {
    await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_A, userId: USER_A });
  });

  it('denies a member of project A when acting on project B', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ _id: PROJECT_B, ownerId: USER_B }));
    // The record for project A simply does not match a query scoped to B.
    (ProjectPermission.findOne as jest.Mock).mockImplementation(async ({ projectId }: any) =>
      projectId === PROJECT_A ? makePermissionRecord({ canEditProject: true }) : null
    );

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_B } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_B, userId: USER_A });
  });

  it('ignores a userId supplied in the body when loading the permission record', async () => {
    await run(
      'canEditProject',
      makeReq({ params: { projectId: PROJECT_A }, body: { userId: USER_B } })
    );

    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_A, userId: USER_A });
  });

  it('fails closed with 500 when the permission lookup throws', async () => {
    (ProjectPermission.findOne as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));

    const { res, next } = await run('canEditProject', makeReq({ params: { projectId: PROJECT_A } }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
