jest.mock('../../models', () => ({
  ProjectPermission: Object.assign(
    jest.fn(),
    {
      findOne: jest.fn(),
      find: jest.fn(),
      findOneAndDelete: jest.fn(),
      getDefaultPermissions: jest.fn(),
    }
  ),
  Project: { findById: jest.fn() },
  User: { findById: jest.fn() },
  AuditLog: { logAction: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { ProjectPermission, Project, User, AuditLog } from '../../models';
import {
  getProjectPermissions,
  getUserPermission,
  updateUserPermission,
  deleteUserPermission,
  getMyPermission,
} from '../permissionsController';

const OWNER = '507f1f77bcf86cd799439001';
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(params: any, overrides: any = {}) {
  return { params, body: {}, user: { _id: USER_A }, ...overrides } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function defaultPerms(role: 'owner' | 'member') {
  const flags = role === 'owner';
  return {
    canCreateTasks: flags,
    canEditTasks: true,
    canDeleteTasks: flags,
    canAssignTasks: flags,
    canEditProject: flags,
    canManageMembers: flags,
    canViewAllTasks: flags,
    canManagePermissions: flags,
    canCreateChatGroups: flags,
    canDeleteChatGroups: flags,
    modules: {
      userManagement: { view: flags, edit: flags },
      projects: { view: true, edit: flags },
    },
  };
}

function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    ownerId: OWNER,
    owners: [] as any[],
    members: [USER_A, USER_B] as any[],
    managers: [] as any[],
    isPersonal: false,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A saved ProjectPermission document as the controller manipulates it. */
function makePermissionDoc(overrides: Record<string, any> = {}) {
  const doc: any = {
    projectId: PROJECT_A,
    userId: USER_B,
    role: 'member',
    permissions: { ...defaultPerms('member') },
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  doc.toJSON = jest.fn(() => ({ id: 'perm-id', projectId: doc.projectId, userId: doc.userId, role: doc.role }));
  return doc;
}

beforeEach(() => {
  (ProjectPermission.getDefaultPermissions as jest.Mock).mockImplementation((role: any) =>
    defaultPerms(role)
  );
  (AuditLog.logAction as jest.Mock).mockResolvedValue(undefined);
  (Project.findById as jest.Mock).mockResolvedValue(makeProject());
  (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
  (User.findById as jest.Mock).mockResolvedValue({ permissions: {} });
});

describe('getProjectPermissions — authorization', () => {
  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies a member holding no canManagePermissions', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      permissions: { canManagePermissions: false },
    });
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You do not have permission to manage permissions');
    expect(ProjectPermission.find).not.toHaveBeenCalled();
  });

  it('denies a user with no permission record at all', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows the main owner to list every permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const chain: any = { populate: jest.fn(() => chain), sort: jest.fn().mockResolvedValue([]) };
    (ProjectPermission.find as jest.Mock).mockReturnValue(chain);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(ProjectPermission.find).toHaveBeenCalledWith({ projectId: PROJECT_A });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a member whose record grants canManagePermissions', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      permissions: { canManagePermissions: true },
    });
    const chain: any = { populate: jest.fn(() => chain), sort: jest.fn().mockResolvedValue([]) };
    (ProjectPermission.find as jest.Mock).mockReturnValue(chain);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  // FINDING (documented, not fixed): any user listed in owners[] passes this
  // gate, with no coOwnerPermissions check. A co-owner restricted to 'view' can
  // read every member's permission record — including their email and role.
  it('lets a view-only co-owner read every permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    const chain: any = { populate: jest.fn(() => chain), sort: jest.fn().mockResolvedValue([]) };
    (ProjectPermission.find as jest.Mock).mockReturnValue(chain);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ProjectPermission.findOne).not.toHaveBeenCalled();
  });

  it('drops permission rows whose user has been deleted', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const rows = [
      { userId: null, role: 'member', permissions: {}, toJSON: () => ({ id: 'a' }) },
      { userId: { _id: USER_B }, role: 'member', permissions: {}, toJSON: () => ({ id: 'b' }) },
    ];
    const chain: any = { populate: jest.fn(() => chain), sort: jest.fn().mockResolvedValue(rows) };
    (ProjectPermission.find as jest.Mock).mockReturnValue(chain);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data).toHaveLength(1);
    expect(payloadOf(res).data[0].id).toBe('b');
  });

  it('forces canManageMembers false for personal projects', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, isPersonal: true })
    );
    const rows = [
      {
        userId: { _id: USER_B },
        role: 'member',
        permissions: { canManageMembers: true },
        toJSON: () => ({ id: 'b' }),
      },
    ];
    const chain: any = { populate: jest.fn(() => chain), sort: jest.fn().mockResolvedValue(rows) };
    (ProjectPermission.find as jest.Mock).mockReturnValue(chain);
    const res = makeRes();

    await getProjectPermissions(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data[0].permissions.canManageMembers).toBe(false);
  });
});

describe('getUserPermission — missing authorization (IDOR)', () => {
  // SECURITY FINDING (documented, not fixed): getUserPermission performs no
  // authorization check whatsoever. It verifies only that the project exists,
  // then returns the requested user's permission record populated with
  // displayName, email, photoURL and role. Any authenticated user can read any
  // other user's project authorization state and contact details, in any
  // project they have no relationship with. Route: GET
  // /api/permissions/project/:projectId/user/:userId (authenticate only).
  it('lets an unrelated non-member read another user’s permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: OWNER, members: [] }));
    const record = {
      role: 'member',
      permissions: { canEditProject: true },
      toJSON: () => ({ id: 'perm', userId: { email: 'victim@example.com', role: 'manager' } }),
    };
    (ProjectPermission.findOne as jest.Mock).mockReturnValue({
      populate: jest.fn().mockResolvedValue(record),
    });
    const res = makeRes();

    await getUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.userId.email).toBe('victim@example.com');
  });

  it('populates the target user’s email and role into the response', async () => {
    const populate = jest.fn().mockResolvedValue({
      role: 'member',
      permissions: {},
      toJSON: () => ({ id: 'perm' }),
    });
    (ProjectPermission.findOne as jest.Mock).mockReturnValue({ populate });
    const res = makeRes();

    await getUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(populate).toHaveBeenCalledWith('userId', 'displayName email photoURL role');
  });

  it('returns 404 when the target has no permission record', async () => {
    (ProjectPermission.findOne as jest.Mock).mockReturnValue({
      populate: jest.fn().mockResolvedValue(null),
    });
    const res = makeRes();

    await getUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('scopes the lookup to the requested project and user pair', async () => {
    (ProjectPermission.findOne as jest.Mock).mockReturnValue({
      populate: jest.fn().mockResolvedValue(null),
    });

    await getUserPermission(makeReq({ projectId: PROJECT_B, userId: USER_B }), makeRes());

    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_B, userId: USER_B });
  });
});

describe('updateUserPermission — authorization', () => {
  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies an ordinary member without canManagePermissions', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      permissions: { canManagePermissions: false },
    });
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You do not have permission to manage permissions');
  });

  it('refuses to let a canManagePermissions holder rewrite the owner’s record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: OWNER }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      permissions: { canManagePermissions: true },
    });
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: OWNER }, { body: { permissions: { canEditProject: false } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot change owner permissions');
  });

  it('blocks changing the owner’s own record even for a co-owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: OWNER, owners: [USER_A] }));
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: OWNER }, { body: { permissions: {} } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot change owner permissions');
  });

  it('lets a view-only co-owner rewrite another member’s permissions', async () => {
    // Same co-owner gap as elsewhere: owners[] membership alone passes the gate.
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER, owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    const doc = makePermissionDoc();
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      res
    );

    expect(doc.save).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('updateUserPermission — permission writes', () => {
  it('updates an existing record and marks the permissions path modified', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const doc = makePermissionDoc();
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      makeRes()
    );

    expect(doc.permissions.canEditProject).toBe(true);
    expect(doc.markModified).toHaveBeenCalledWith('permissions');
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('persists an explicit false rather than dropping it', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const doc = makePermissionDoc({ permissions: { ...defaultPerms('member'), canEditTasks: true } });
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditTasks: false } } }),
      makeRes()
    );

    expect(doc.permissions.canEditTasks).toBe(false);
  });

  it('forces canManageMembers false on a personal project even when requested true', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, isPersonal: true })
    );
    const doc = makePermissionDoc();
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canManageMembers: true } } }),
      makeRes()
    );

    expect(doc.permissions.canManageMembers).toBe(false);
  });

  it('writes an audit entry attributing the change to the acting user', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(makePermissionDoc());

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      makeRes()
    );

    expect(AuditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_A,
        userId: USER_A,
        action: 'permission_changed',
        entityId: USER_B,
      })
    );
  });

  it('still succeeds when audit logging fails', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(makePermissionDoc());
    (AuditLog.logAction as jest.Mock).mockRejectedValue(new Error('audit sink offline'));
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 when the save fails', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionDoc({ save: jest.fn().mockRejectedValue(new Error('write failed')) })
    );
    const res = makeRes();

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateUserPermission — global privilege escalation', () => {
  // SECURITY FINDING (critical, documented, not fixed): a PROJECT-scoped
  // permission update writes a GLOBAL user permission. Setting
  // modules.userManagement.edit = true on a project permission record causes
  // the controller to set targetUser.permissions.canManageUsers = true on the
  // User document — a tenant-wide privilege granted from inside a single
  // project by anyone who can manage that project's permissions.
  it('grants the target GLOBAL canManageUsers from a project-scoped update', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const doc = makePermissionDoc({
      permissions: { ...defaultPerms('member'), modules: { userManagement: { view: true, edit: true } } },
    });
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);
    const targetUser: any = { permissions: {}, save: jest.fn().mockResolvedValue(undefined) };
    (User.findById as jest.Mock).mockResolvedValue(targetUser);

    await updateUserPermission(
      makeReq(
        { projectId: PROJECT_A, userId: USER_B },
        { body: { permissions: { modules: { userManagement: { view: true, edit: true } } } } }
      ),
      makeRes()
    );

    expect(User.findById).toHaveBeenCalledWith(USER_B);
    expect(targetUser.permissions.canManageUsers).toBe(true);
    expect(targetUser.save).toHaveBeenCalledTimes(1);
  });

  // A co-owner or canManagePermissions holder is never equal to ownerId, so the
  // "Cannot change owner permissions" guard does not stop them targeting
  // themselves — self-escalation to global canManageUsers.
  it('allows a project permission manager to escalate THEMSELVES to global canManageUsers', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: OWNER, owners: [USER_A] }));
    const doc = makePermissionDoc({
      userId: USER_A,
      permissions: { ...defaultPerms('member'), modules: { userManagement: { view: true, edit: true } } },
    });
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);
    const self: any = { permissions: {}, save: jest.fn().mockResolvedValue(undefined) };
    (User.findById as jest.Mock).mockResolvedValue(self);
    const res = makeRes();

    await updateUserPermission(
      makeReq(
        { projectId: PROJECT_A, userId: USER_A },
        { body: { permissions: { modules: { userManagement: { view: true, edit: true } } } } }
      ),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(self.permissions.canManageUsers).toBe(true);
  });

  it('revokes global canManageUsers when the module edit flag is set false', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const doc = makePermissionDoc({
      permissions: { ...defaultPerms('member'), modules: { userManagement: { view: true, edit: false } } },
    });
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(doc);
    const targetUser: any = {
      permissions: { canManageUsers: true },
      save: jest.fn().mockResolvedValue(undefined),
    };
    (User.findById as jest.Mock).mockResolvedValue(targetUser);

    await updateUserPermission(
      makeReq(
        { projectId: PROJECT_A, userId: USER_B },
        { body: { permissions: { modules: { userManagement: { view: true, edit: false } } } } }
      ),
      makeRes()
    );

    expect(targetUser.permissions.canManageUsers).toBe(false);
    expect(targetUser.save).toHaveBeenCalledTimes(1);
  });

  it('does not touch global permissions when the userManagement module is untouched', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionDoc({ permissions: { ...defaultPerms('member'), modules: { projects: { view: true } } } })
    );
    const targetUser: any = { permissions: {}, save: jest.fn() };
    (User.findById as jest.Mock).mockResolvedValue(targetUser);

    await updateUserPermission(
      makeReq({ projectId: PROJECT_A, userId: USER_B }, { body: { permissions: { canEditProject: true } } }),
      makeRes()
    );

    expect(targetUser.save).not.toHaveBeenCalled();
  });

  it('still reports success when the global permission write fails', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(
      makePermissionDoc({
        permissions: { ...defaultPerms('member'), modules: { userManagement: { view: true, edit: true } } },
      })
    );
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: {},
      save: jest.fn().mockRejectedValue(new Error('user write failed')),
    });
    const res = makeRes();

    await updateUserPermission(
      makeReq(
        { projectId: PROJECT_A, userId: USER_B },
        { body: { permissions: { modules: { userManagement: { view: true, edit: true } } } } }
      ),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('deleteUserPermission', () => {
  it('denies a member without canManagePermissions', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      permissions: { canManagePermissions: false },
    });
    const res = makeRes();

    await deleteUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(ProjectPermission.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('refuses to remove the project owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const res = makeRes();

    await deleteUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_A }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot remove owner from project');
    expect(ProjectPermission.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('deletes the record and strips the user from members and managers', async () => {
    const project = makeProject({ ownerId: USER_A, members: [USER_A, USER_B], managers: [USER_B] });
    (Project.findById as jest.Mock).mockResolvedValue(project);
    const res = makeRes();

    await deleteUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), res);

    expect(ProjectPermission.findOneAndDelete).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      userId: USER_B,
    });
    expect(project.members.map(String)).not.toContain(USER_B);
    expect(project.managers.map(String)).not.toContain(USER_B);
    expect(project.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('records a member_removed audit entry', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));

    await deleteUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), makeRes());

    expect(AuditLog.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'member_removed', entityId: USER_B, userId: USER_A })
    );
  });

  it('leaves the target’s GLOBAL permissions untouched when removing them from a project', async () => {
    // Contrast with updateUserPermission, which does write global permissions.
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const targetUser: any = { permissions: { canManageUsers: true }, save: jest.fn() };
    (User.findById as jest.Mock).mockResolvedValue(targetUser);

    await deleteUserPermission(makeReq({ projectId: PROJECT_A, userId: USER_B }), makeRes());

    expect(targetUser.save).not.toHaveBeenCalled();
    expect(targetUser.permissions.canManageUsers).toBe(true);
  });
});

describe('getMyPermission — global/project permission merging', () => {
  it('returns 404 for a user with no permission record', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('reports the main owner as owner with the full owner permission set', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.isOwner).toBe(true);
    expect(payloadOf(res).data.role).toBe('owner');
    expect(payloadOf(res).data.permissions.canManagePermissions).toBe(true);
  });

  // FINDING (documented, not fixed): co-owner level is ignored here too — a
  // 'view' co-owner is reported to the client as a full owner, so the UI will
  // offer them every owner action.
  it('reports a view-only co-owner as a full owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER, owners: [USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.isOwner).toBe(true);
    expect(payloadOf(res).data.permissions.canEditProject).toBe(true);
  });

  it('forces canManageMembers false for an owner of a personal project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, isPersonal: true })
    );
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.permissions.canManageMembers).toBe(false);
  });

  // FINDING (documented, not fixed): every global boolean permission that is
  // true is copied over the project-level value, so a global grant silently
  // overrides an explicit project-level denial.
  it('lets a true global permission override an explicit project-level false', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member'), canDeleteTasks: false },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canDeleteTasks: true } });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.permissions.canDeleteTasks).toBe(true);
  });

  it('expands global canManageAllProjects into project edit, member and permission rights', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member') },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageAllProjects: true } });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    const perms = payloadOf(res).data.permissions;
    expect(perms.canEditProject).toBe(true);
    expect(perms.canManageMembers).toBe(true);
    expect(perms.canManagePermissions).toBe(true);
  });

  it('expands global canViewAllProjects into canViewAllTasks', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member') },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canViewAllProjects: true } });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.permissions.canViewAllTasks).toBe(true);
  });

  it('applies an explicit global manageMembers false over a project-level true', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member'), canManageMembers: true },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({
      permissions: { modules: { projects: { manageMembers: false } } },
    });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.permissions.canManageMembers).toBe(false);
  });

  // FINDING (documented, not fixed): combined with updateUserPermission this
  // forms a closed escalation loop — a project grant of userManagement.edit
  // sets global canManageUsers, and global canManageUsers is then reflected
  // back as userManagement view+edit on every project the user belongs to.
  it('reflects global canManageUsers back into project userManagement view and edit', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member'), modules: { userManagement: { view: false, edit: false } } },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canManageUsers: true } });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    const um = payloadOf(res).data.permissions.modules.userManagement;
    expect(um.view).toBe(true);
    expect(um.edit).toBe(true);
  });

  it('scopes the lookup to the authenticated user, not a body-supplied id', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);

    await getMyPermission(
      makeReq({ projectId: PROJECT_A }, { body: { userId: USER_B } }),
      makeRes()
    );

    expect(ProjectPermission.findOne).toHaveBeenCalledWith({ projectId: PROJECT_A, userId: USER_A });
  });

  it('returns the caller’s global permissions alongside the project ones', async () => {
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({
      role: 'member',
      permissions: { ...defaultPerms('member') },
      toJSON: () => ({ id: 'perm' }),
    });
    (User.findById as jest.Mock).mockResolvedValue({ permissions: { canCreateProjects: true } });
    const res = makeRes();

    await getMyPermission(makeReq({ projectId: PROJECT_A }), res);

    expect(payloadOf(res).data.globalPermissions).toEqual({ canCreateProjects: true });
  });
});
