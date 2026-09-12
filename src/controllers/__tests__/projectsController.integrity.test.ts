/**
 * Project CRUD, membership and ownership data integrity.
 *
 * Route-level permission middleware (checkCanCreateProject, checkCanDeleteProject,
 * checkPermission('canEditProject'/'canManageMembers')) was covered in Batch 3.
 * These tests exercise the controller's own validation, ownership assignment and
 * scoping — including the owner-management routes, which carry no middleware at all.
 */

jest.mock('../../models', () => ({
  Task: Object.assign(jest.fn(), {
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  }),
  Project: Object.assign(jest.fn(), {
    findById: jest.fn(),
    find: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  }),
  User: { findById: jest.fn(), find: jest.fn(), findOne: jest.fn() },
  ProjectPermission: {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    findOneAndDelete: jest.fn(),
    getDefaultPermissions: jest.fn(() => ({ canEditTasks: true })),
  },
  AuditLog: { logAction: jest.fn(), logSystemEvent: jest.fn() },
  Notification: { create: jest.fn(), insertMany: jest.fn(), deleteMany: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../socket', () => ({
  getIO: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })), emit: jest.fn() })),
}));

jest.mock('../../socket/socketHandlers', () => ({
  broadcastToProject: jest.fn(),
  broadcastToUser: jest.fn(),
}));

jest.mock('../../models/ProjectPermission', () => ({
  ProjectPermission: {
    findOne: jest.fn(),
    create: jest.fn(),
    getDefaultPermissions: jest.fn(() => ({ canEditTasks: true })),
  },
}));

jest.mock('../../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendTaskAssignmentEmail: jest.fn() },
}));

jest.mock('../notificationController', () => ({
  createNotification: jest.fn(),
}));

import { Project, User } from '../../models';
import { ProjectPermission } from '../../models/ProjectPermission';
import {
  getProject,
  createProject,
  updateProject,
  addMember,
  removeMember,
  updateMemberRole,
  addOwner,
  removeOwner,
  transferOwnership,
  leaveProject,
} from '../projectsController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const OWNER_B = '507f1f77bcf86cd799439033';
const OUTSIDER = '507f1f77bcf86cd7994390ff';
const PROJECT_A = '607f1f77bcf86cd7994390a1';
const PROJECT_B = '607f1f77bcf86cd7994390b2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A' },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** Project A: owned by OWNER_B; USER_A is an ordinary member. */
function makeProject(overrides: Record<string, any> = {}) {
  return {
    _id: PROJECT_A,
    name: 'Project A',
    description: 'desc',
    ownerId: OWNER_B,
    owners: [OWNER_B] as any[],
    members: [USER_A, USER_B] as any[],
    managers: [] as any[],
    columns: [{ id: 'todo' }],
    isPersonal: false,
    coOwnerPermissions: undefined as any,
    save: jest.fn().mockResolvedValue(undefined),
    toJSON() {
      const { save, toJSON, ...rest } = this as any;
      return rest;
    },
    ...overrides,
  };
}

/** Project.findById(...).populate()... — chainable, resolving to `doc`. */
function mockFindByIdChain(doc: any) {
  const chain: any = { populate: jest.fn(() => chain) };
  chain.then = (resolve: any) => Promise.resolve(doc).then(resolve);
  return chain;
}

beforeEach(() => {
  (Project.findById as jest.Mock).mockResolvedValue(makeProject());
  (User.findById as jest.Mock).mockResolvedValue({ _id: USER_B, isActive: true });
  (User.findOne as jest.Mock).mockResolvedValue({ _id: USER_B, isActive: true });
  (User.find as jest.Mock).mockResolvedValue([{ _id: USER_B }]);
  (ProjectPermission.findOne as jest.Mock).mockResolvedValue(null);
  (ProjectPermission.create as jest.Mock).mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────────
// getProject
// ─────────────────────────────────────────────────────────────────────────────

describe('getProject — read isolation', () => {
  it('rejects a malformed project id with 400', async () => {
    const res = makeRes();

    await getProject(makeReq({ params: { id: 'not-an-objectid' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid project ID');
  });

  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getProject(makeReq({ params: { id: PROJECT_A }, user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockReturnValue(mockFindByIdChain(null));
    const res = makeRes();

    await getProject(makeReq({ params: { id: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies a user who is neither owner, co-owner, manager nor member', async () => {
    (Project.findById as jest.Mock).mockReturnValue(
      mockFindByIdChain(makeProject({ members: [USER_B], owners: [OWNER_B] }))
    );
    const res = makeRes();

    await getProject(makeReq({ params: { id: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Access denied to this project');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createProject
// ─────────────────────────────────────────────────────────────────────────────

describe('createProject — validation and ownership assignment', () => {
  it('requires a project name', async () => {
    const res = makeRes();

    await createProject(makeReq({ body: { name: '   ' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Project name is required');
  });

  it('rejects a name longer than 100 characters', async () => {
    const res = makeRes();

    await createProject(makeReq({ body: { name: 'x'.repeat(101) } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Project name must be less than 100 characters');
  });

  it('rejects members on a personal project', async () => {
    const res = makeRes();

    await createProject(makeReq({ body: { name: 'Mine', isPersonal: true, members: [USER_B] } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Personal projects cannot have members added');
  });

  it('rejects member ids that do not resolve to active users', async () => {
    (User.find as jest.Mock).mockResolvedValue([]); // none of the ids matched
    const res = makeRes();

    await createProject(makeReq({ body: { name: 'Team', members: [USER_B, OUTSIDER] } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Some selected members are invalid');
  });

  it('assigns ownership to the authenticated creator, ignoring a body-supplied ownerId', async () => {
    (User.find as jest.Mock).mockResolvedValue([]);

    await createProject(
      makeReq({ body: { name: 'Team', ownerId: USER_B, owners: [USER_B] } }),
      makeRes()
    );

    const constructed = (Project as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.ownerId).toBe(USER_A);
    expect(constructed.owners).toEqual([USER_A]);
  });

  it('always includes the creator in members and de-duplicates them', async () => {
    // Both supplied ids must resolve to active users for validation to pass.
    (User.find as jest.Mock).mockResolvedValue([{ _id: USER_B }, { _id: USER_A }]);

    await createProject(makeReq({ body: { name: 'Team', members: [USER_B, USER_A] } }), makeRes());

    const constructed = (Project as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.members.filter((m: string) => m === USER_A)).toHaveLength(1);
    expect(constructed.members).toContain(USER_B);
  });

  it('restricts a personal project’s membership to the creator alone', async () => {
    await createProject(makeReq({ body: { name: 'Mine', isPersonal: true } }), makeRes());

    const constructed = (Project as unknown as jest.Mock).mock.calls[0]?.[0];
    expect(constructed.members).toEqual([USER_A]);
    expect(constructed.isPersonal).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateProject
// ─────────────────────────────────────────────────────────────────────────────

describe('updateProject — validation and field scoping', () => {
  it('rejects a malformed project id', async () => {
    const res = makeRes();

    await updateProject(makeReq({ params: { id: 'bad-id' }, body: { name: 'X' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateProject(makeReq({ params: { id: PROJECT_A }, body: { name: 'X' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejects an empty name and an over-long name', async () => {
    for (const name of ['   ', 'x'.repeat(101)]) {
      const res = makeRes();
      await updateProject(makeReq({ params: { id: PROJECT_A }, body: { name } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(Project.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a description over 500 characters', async () => {
    const res = makeRes();

    await updateProject(
      makeReq({ params: { id: PROJECT_A }, body: { description: 'x'.repeat(501) } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Description must be less than 500 characters');
  });

  it('rejects a status outside the allowed set', async () => {
    const res = makeRes();

    await updateProject(makeReq({ params: { id: PROJECT_A }, body: { status: 'deleted' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid status');
  });

  it('rejects a member list containing ids that are not active users', async () => {
    (User.find as jest.Mock).mockResolvedValue([]);
    const res = makeRes();

    await updateProject(
      makeReq({ params: { id: PROJECT_A }, body: { members: [USER_B, OUTSIDER] } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Some selected members are invalid');
  });

  // Contrast with updateTask, which spreads req.body wholesale.
  it('writes only name, description, members and status — ignoring other body fields', async () => {
    (Project.findByIdAndUpdate as jest.Mock).mockReturnValue(mockFindByIdChain(makeProject()));

    await updateProject(
      makeReq({
        params: { id: PROJECT_A },
        body: {
          status: 'archived',
          ownerId: USER_A,
          owners: [USER_A],
          managers: [USER_A],
          isPersonal: true,
        },
      }),
      makeRes()
    );

    const applied = (Project.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied).toEqual({ status: 'archived' });
    expect(applied).not.toHaveProperty('ownerId');
    expect(applied).not.toHaveProperty('owners');
    expect(applied).not.toHaveProperty('managers');
    expect(applied).not.toHaveProperty('isPersonal');
  });

  it('updates the project named in the route, ignoring an id in the body', async () => {
    (Project.findByIdAndUpdate as jest.Mock).mockReturnValue(mockFindByIdChain(makeProject()));

    await updateProject(
      makeReq({ params: { id: PROJECT_A }, body: { status: 'active', _id: PROJECT_B, id: PROJECT_B } }),
      makeRes()
    );

    expect((Project.findByIdAndUpdate as jest.Mock).mock.calls[0][0]).toBe(PROJECT_A);
  });

  it('drops the acting user from a supplied members list', async () => {
    (User.find as jest.Mock).mockResolvedValue([{ _id: USER_A }, { _id: USER_B }]);
    (Project.findByIdAndUpdate as jest.Mock).mockReturnValue(mockFindByIdChain(makeProject()));

    await updateProject(
      makeReq({ params: { id: PROJECT_A }, body: { members: [USER_A, USER_B] } }),
      makeRes()
    );

    const applied = (Project.findByIdAndUpdate as jest.Mock).mock.calls[0][1];
    expect(applied.members).toEqual([USER_B]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership
// ─────────────────────────────────────────────────────────────────────────────

describe('addMember', () => {
  it('rejects a malformed project or user id', async () => {
    for (const params of [{ id: 'bad' }, { id: PROJECT_A }]) {
      const res = makeRes();
      const body = params.id === PROJECT_A ? { userId: 'bad-user' } : { userId: USER_B };
      await addMember(makeReq({ params, body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Invalid ID provided');
    }
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('refuses to add members to a personal project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ isPersonal: true }));
    const res = makeRes();

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Cannot add members to personal projects');
  });

  it('rejects a target user that is missing or inactive', async () => {
    (User.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: OUTSIDER } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('User not found or inactive');
    expect(User.findOne).toHaveBeenCalledWith({ _id: OUTSIDER, isActive: true });
  });

  it('rejects a duplicate membership', async () => {
    const res = makeRes();

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('User is already a member of this project');
  });

  it('adds a new member to the project named in the route and persists it', async () => {
    const project = makeProject({ members: [USER_A] });
    (Project.findById as jest.Mock).mockResolvedValue(project);

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), makeRes());

    expect(project.members).toContain(USER_B);
    expect(project.save).toHaveBeenCalledTimes(1);
    expect(Project.findById).toHaveBeenCalledWith(PROJECT_A);
  });

  it('creates a scoped permission record for the new member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ members: [USER_A] }));

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), makeRes());

    expect(ProjectPermission.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, userId: USER_B, role: 'member' })
    );
  });

  it('does not duplicate an existing permission record', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ members: [USER_A] }));
    (ProjectPermission.findOne as jest.Mock).mockResolvedValue({ _id: 'existing' });

    await addMember(makeReq({ params: { id: PROJECT_A }, body: { userId: USER_B } }), makeRes());

    expect(ProjectPermission.create).not.toHaveBeenCalled();
  });
});

describe('removeMember', () => {
  it('rejects malformed ids', async () => {
    const res = makeRes();

    await removeMember(makeReq({ params: { id: PROJECT_A, userId: 'bad' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid ID provided');
  });

  it('returns 404 for a nonexistent project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await removeMember(makeReq({ params: { id: PROJECT_A, userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('stops a non-owner from removing a project manager', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER_B, managers: [USER_B] })
    );
    const res = makeRes();

    await removeMember(makeReq({ params: { id: PROJECT_A, userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only project owner can remove a manager');
  });

  it('stops a non-owner from removing a co-owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER_B, owners: [OWNER_B, USER_B] })
    );
    const res = makeRes();

    await removeMember(makeReq({ params: { id: PROJECT_A, userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only the project owner can remove other owners');
  });

  it('stops a non-owner from removing the main owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: OWNER_B }));
    const res = makeRes();

    await removeMember(makeReq({ params: { id: PROJECT_A, userId: OWNER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('updateMemberRole', () => {
  it('accepts only the "member" role', async () => {
    const res = makeRes();

    await updateMemberRole(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { role: 'admin' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid role. Only "member" is allowed');
    expect(Project.findById).not.toHaveBeenCalled();
  });

  it('rejects a target who belongs to neither members nor managers', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ members: [USER_A], managers: [] }));
    const res = makeRes();

    await updateMemberRole(
      makeReq({ params: { id: PROJECT_A, userId: OUTSIDER }, body: { role: 'member' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('User is not a member of this project');
  });

  it('refuses to change the main owner’s role', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER_B, members: [OWNER_B, USER_A] })
    );
    const res = makeRes();

    await updateMemberRole(
      makeReq({ params: { id: PROJECT_A, userId: OWNER_B }, body: { role: 'member' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Cannot change the role of the project owner');
  });

  it('lets only the original owner demote a co-owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: OWNER_B, owners: [OWNER_B, USER_B], members: [USER_A, USER_B] })
    );
    const res = makeRes();

    await updateMemberRole(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { role: 'member' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe(
      'Only the original project owner can change roles of additional owners'
    );
  });

  it('moves a manager into members when demoted by the owner', async () => {
    const project = makeProject({
      ownerId: USER_A,
      members: [USER_A],
      managers: [USER_B],
    });
    (Project.findById as jest.Mock)
      .mockResolvedValueOnce(project)
      .mockReturnValue(mockFindByIdChain(project));

    await updateMemberRole(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { role: 'member' } }),
      makeRes()
    );

    expect(project.managers.map(String)).not.toContain(USER_B);
    expect(project.members.map(String)).toContain(USER_B);
    expect(project.save).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner management (no route middleware — controller checks only)
// ─────────────────────────────────────────────────────────────────────────────

describe('addOwner', () => {
  it('denies an ordinary member', async () => {
    const res = makeRes();

    await addOwner(makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only project owner can add owners');
  });

  it('denies a view-only co-owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [OWNER_B, USER_A], coOwnerPermissions: { [USER_A]: 'view' } })
    );
    const res = makeRes();

    await addOwner(makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects an invalid co-owner permission level', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const res = makeRes();

    await addOwner(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { permission: 'admin' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid co-owner permission. Use "view" or "edit"');
  });

  it('requires the target to already be a project member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, members: [USER_A] })
    );
    const res = makeRes();

    await addOwner(makeReq({ params: { id: PROJECT_A, userId: OUTSIDER }, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('User is not a member of this project');
  });

  it('rejects promoting someone who is already an owner', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, owners: [USER_A, USER_B], members: [USER_B] })
    );
    const res = makeRes();

    await addOwner(makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('User is already an owner');
  });

  it('promotes an edit co-owner into managers and out of members', async () => {
    const project = makeProject({ ownerId: USER_A, owners: [USER_A], members: [USER_B] });
    (Project.findById as jest.Mock)
      .mockResolvedValueOnce(project)
      .mockReturnValue(mockFindByIdChain(project));

    await addOwner(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { permission: 'edit' } }),
      makeRes()
    );

    expect(project.managers.map(String)).toContain(USER_B);
    expect(project.members.map(String)).not.toContain(USER_B);
    expect(project.save).toHaveBeenCalledTimes(1);
  });

  it('keeps a view co-owner out of managers', async () => {
    const project = makeProject({ ownerId: USER_A, owners: [USER_A], members: [USER_B] });
    (Project.findById as jest.Mock)
      .mockResolvedValueOnce(project)
      .mockReturnValue(mockFindByIdChain(project));

    await addOwner(
      makeReq({ params: { id: PROJECT_A, userId: USER_B }, body: { permission: 'view' } }),
      makeRes()
    );

    expect(project.managers.map(String)).not.toContain(USER_B);
    expect(project.owners.map(String)).toContain(USER_B);
  });
});

describe('removeOwner and transferOwnership', () => {
  it('lets only the main owner remove an owner', async () => {
    const res = makeRes();

    await removeOwner(makeReq({ params: { id: PROJECT_A, userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only project owner can remove owners');
  });

  it('denies an edit co-owner from removing owners', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ owners: [OWNER_B, USER_A], coOwnerPermissions: { [USER_A]: 'edit' } })
    );
    const res = makeRes();

    await removeOwner(makeReq({ params: { id: PROJECT_A, userId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects malformed ids on transfer', async () => {
    const res = makeRes();

    await transferOwnership(makeReq({ params: { id: PROJECT_A }, body: { newOwnerId: 'bad' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid ID provided');
  });

  it('lets only the main owner transfer ownership', async () => {
    const res = makeRes();

    await transferOwnership(makeReq({ params: { id: PROJECT_A }, body: { newOwnerId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Only the project owner can transfer ownership');
  });

  it('refuses a transfer to yourself', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    const res = makeRes();

    await transferOwnership(makeReq({ params: { id: PROJECT_A }, body: { newOwnerId: USER_A } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot transfer ownership to yourself');
  });

  it('requires the new owner to exist', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ ownerId: USER_A }));
    (User.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await transferOwnership(makeReq({ params: { id: PROJECT_A }, body: { newOwnerId: USER_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('New owner user not found');
  });

  it('requires the new owner to already belong to the project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, members: [USER_A], managers: [] })
    );
    const res = makeRes();

    await transferOwnership(
      makeReq({ params: { id: PROJECT_A }, body: { newOwnerId: OUTSIDER } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('New owner must be a member or manager of the project');
  });
});

describe('leaveProject', () => {
  it('rejects a user who is not a member', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(makeProject({ members: [USER_B] }));
    const res = makeRes();

    await leaveProject(makeReq({ params: { id: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('You are not a member of this project');
  });

  it('refuses to let the main owner leave their own project', async () => {
    (Project.findById as jest.Mock).mockResolvedValue(
      makeProject({ ownerId: USER_A, members: [USER_A] })
    );
    const res = makeRes();

    await leaveProject(makeReq({ params: { id: PROJECT_A } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Project owner cannot leave their own project');
  });

  it('removes only the acting user from members and managers', async () => {
    const project = makeProject({ members: [USER_A, USER_B], managers: [USER_A, USER_B] });
    (Project.findById as jest.Mock).mockResolvedValue(project);

    await leaveProject(makeReq({ params: { id: PROJECT_A } }), makeRes());

    expect(project.members.map(String)).toEqual([USER_B]);
    expect(project.managers.map(String)).toEqual([USER_B]);
    expect(project.save).toHaveBeenCalledTimes(1);
  });
});
