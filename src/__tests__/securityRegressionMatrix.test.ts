/**
 * FINAL SECURITY REGRESSION MATRIX
 *
 * One representative lock for each significant finding from Batches 1–7, in a
 * single place. These deliberately assert CURRENT behaviour — several of them
 * encode insecure behaviour on purpose. When a vulnerability is genuinely
 * fixed, the corresponding test here SHOULD fail; that is the signal, and the
 * test should then be updated to assert the fixed behaviour.
 *
 * Nothing here is a substitute for the detailed per-module suites — it is a
 * fast tripwire over the highest-value issues.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

/** Reads a production source file as text for structural assertions. */
function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf8');
}

/** Extracts the body of a named exported handler, up to the next top-level export. */
function handlerBody(relativePath: string, exportName: string): string {
  const text = source(relativePath);
  const start = text.indexOf(`export const ${exportName}`);
  const startFn = start !== -1 ? start : text.indexOf(`export async function ${exportName}`);
  if (startFn === -1) throw new Error(`${exportName} not found in ${relativePath}`);
  const rest = text.slice(startFn + 1);
  const nextExport = rest.search(/\nexport (const|async function|function) /);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe('regression matrix — authentication and session enforcement', () => {
  // Batch 1 / Batch 5: password-login tokens are minted with no expiry.
  it('login still signs its token with an empty options object (no expiry)', () => {
    const body = handlerBody('controllers/authController.ts', 'login');

    expect(body).toContain('jwt.sign');
    expect(body).not.toContain('expiresIn');
  });

  // Batch 1: session validation is gated on the token carrying a jti.
  it('authenticate still gates the session check on `if (decoded.jti)`', () => {
    const text = source('middleware/auth.ts');

    expect(text).toContain('if (decoded.jti)');
    expect(text).toContain('activeSessions');
  });

  // Batch 1: optionalAuth performs no session validation at all.
  it('optionalAuth still contains no activeSessions check', () => {
    const text = source('middleware/auth.ts');
    const optional = text.slice(text.indexOf('export const optionalAuth'));
    const body = optional.slice(0, optional.indexOf('export const requireManagerOrAdmin'));

    expect(body).not.toContain('activeSessions');
  });

  // Batch 5: the socket layer likewise never validates the session.
  it('socketAuth still contains no activeSessions check', () => {
    expect(source('socket/socketAuth.ts')).not.toContain('activeSessions');
  });

  // Batch 1 / Batch 5: these gates read fields authenticate never attaches.
  it('requireActiveUser and requireEmailVerified still read fields authenticate omits', () => {
    const text = source('middleware/auth.ts');
    const projection = text.slice(text.indexOf('req.user = {'), text.indexOf('next();'));

    expect(projection).not.toContain('isActive');
    expect(projection).not.toContain('emailVerified');
    expect(text).toContain('req.user.isActive');
    expect(text).toContain('req.user.emailVerified');
  });
});

describe('regression matrix — credential storage and exposure', () => {
  // Batch 2: plainPassword is written BEFORE hashing, so it holds the real password.
  it('the User pre-save hook still encrypts the password before hashing it', () => {
    const text = source('models/User.ts');
    const encryptAt = text.indexOf('this.plainPassword = encrypt(this.password)');
    const hashAt = text.indexOf('this.password = await bcrypt.hash');

    expect(encryptAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(-1);
    expect(encryptAt).toBeLessThan(hashAt);
  });

  // Batch 2: an endpoint decrypts and serves those stored passwords.
  it('getAllUsersWithPasswords still decrypts plainPassword into its response', () => {
    const body = handlerBody('controllers/authController.ts', 'getAllUsersWithPasswords');

    expect(body).toContain('decrypt(user.plainPassword)');
  });

  // Batch 8: the admin passkey endpoint decrypts the second factor.
  it('getUserPasskey still returns a decrypted passkey', () => {
    const body = handlerBody('controllers/userController.ts', 'getUserPasskey');

    expect(body).toContain('decrypt(user.passkey)');
    expect(body).toContain('passkey: decryptedPasskey');
  });

  // Batch 2: the model's toJSON is the only scrubber, and toObject bypasses it.
  it('User.toJSON still strips password and plainPassword', () => {
    const text = source('models/User.ts');

    expect(text).toContain('delete user.password');
    expect(text).toContain('delete user.plainPassword');
  });
});

describe('regression matrix — password reset policy', () => {
  // Batch 2: reset enforces only a 6-character minimum, bypassing the real policy.
  it('resetPassword still enforces only a length check and never calls validatePassword', () => {
    const body = handlerBody('controllers/authController.ts', 'resetPassword');

    expect(body).toContain('newPassword.length < 6');
    expect(body).not.toContain('validatePassword');
  });

  // Batch 2: the authenticated change path DOES apply the full policy.
  it('updatePassword still applies the full validatePassword policy', () => {
    const body = handlerBody('controllers/authController.ts', 'updatePassword');

    expect(body).toContain('validatePassword');
  });

  // Batch 2: neither credential-change path clears sessions.
  it('neither updatePassword nor resetPassword clears activeSessions', () => {
    for (const handler of ['updatePassword', 'resetPassword']) {
      expect(handlerBody('controllers/authController.ts', handler)).not.toContain('activeSessions');
    }
  });
});

describe('regression matrix — permission boundaries', () => {
  // Batch 3: co-owner level defaults to 'edit' when unset — fails open.
  it('checkPermission still defaults an unlisted co-owner to edit', () => {
    const text = source('middleware/permissions.ts');

    expect(text).toContain("let coOwnerPermission: 'view' | 'edit' = 'edit'");
    expect(text).toContain("|| 'edit'");
  });

  // Batch 3: the task middleware ignores co-owner level entirely.
  it('checkCanEditTask still grants on isInOwners without reading coOwnerPermissions', () => {
    const text = source('middleware/permissions.ts');
    const editTask = text.slice(text.indexOf('export const checkCanEditTask'));
    const body = editTask.slice(0, editTask.indexOf('export const checkCanDeleteTask'));

    expect(body).toContain('isOwner || isInOwners');
    expect(body).not.toContain('coOwnerPermissions');
  });

  // Batch 3: a project-level canManageMembers grant is unreachable.
  it('checkPermission still returns before the ProjectPermission lookup for canManageMembers', () => {
    const text = source('middleware/permissions.ts');
    const manageAt = text.indexOf("if (permission === 'canManageMembers')");
    const lookupAt = text.indexOf('ProjectPermission.findOne');

    expect(manageAt).toBeGreaterThan(-1);
    expect(manageAt).toBeLessThan(lookupAt);
  });

  // Batch 3: a project-scoped update writes a GLOBAL user permission.
  it('updateUserPermission still writes global canManageUsers from a project update', () => {
    const body = handlerBody('controllers/permissionsController.ts', 'updateUserPermission');

    expect(body).toContain('targetUser.permissions.canManageUsers = true');
    expect(body).toContain('modules?.userManagement?.edit === true');
  });

  // Batch 3: getUserPermission has no authorization check at all.
  it('getUserPermission still performs no ownership or permission check', () => {
    const body = handlerBody('controllers/permissionsController.ts', 'getUserPermission');

    expect(body).not.toContain('canManagePermissions');
    expect(body).not.toContain('isOwner');
  });
});

describe('regression matrix — task and project data integrity', () => {
  // Batch 4: the model static ignores its projectId argument.
  it('Task.reorderTasks still ignores projectId and updates by task id alone', () => {
    const text = source('models/Task.ts');
    const staticAt = text.indexOf('TaskSchema.statics.reorderTasks');
    const body = text.slice(staticAt, text.indexOf('const Task = mongoose.model'));

    expect(body).toContain('findByIdAndUpdate');
    expect((body.match(/projectId/g) || []).length).toBe(1); // signature only
  });

  // Batch 4: the reorder controller never verifies the task ids belong to the project.
  it('reorderTasks still passes client task ids straight to the batch write', () => {
    const body = handlerBody('controllers/tasksController.ts', 'reorderTasks');

    expect(body).toContain('Task.reorderTasks');
    expect(body).not.toContain('Task.find');
  });

  // Batch 4: updateTask spreads req.body with no whitelist.
  it('updateTask still spreads req.body into findByIdAndUpdate unfiltered', () => {
    const body = handlerBody('controllers/tasksController.ts', 'updateTask');

    expect(body).toContain('const updates = req.body');
    expect(body).toContain('{ ...updates }');
  });

  // Batch 4: the contrast case — createTask builds an explicit field list.
  it('createTask still forces createdBy to the authenticated user', () => {
    const body = handlerBody('controllers/tasksController.ts', 'createTask');

    expect(body).toContain('createdBy: req.user._id');
  });
});

describe('regression matrix — tenant data isolation', () => {
  // Batch 6: the "super admin" module-data route has no role gate.
  it('the module-data route still carries no requireSuperAdmin middleware', () => {
    const text = source('routes/user.ts');
    const line = text.split('\n').find((l) => l.includes('module-data'))!;

    expect(line).toContain('getAdminUserModuleData');
    expect(line).not.toContain('requireSuperAdmin');
    expect(line).not.toContain('requireAdmin');
  });

  it('getAdminUserModuleData still never reads req.user', () => {
    const body = handlerBody('controllers/superAdminController.ts', 'getAdminUserModuleData');

    expect(body).toContain('req.params');
    expect(body).not.toContain('req.user');
  });

  // Batch 6: audit logs are unscoped and client-steerable.
  it('getAuditLogs still builds its query without reference to req.user', () => {
    const body = handlerBody('controllers/auditController.ts', 'getAuditLogs');

    expect(body).toContain('query.projectId = projectId');
    expect(body).toContain('query.userId = userId');
    expect(body).not.toContain('req.user._id');
  });

  // Batch 6: support tickets are globally readable.
  it('getAllTickets and getTicket still apply no ownership filter', () => {
    for (const handler of ['getAllTickets', 'getTicket']) {
      const body = handlerBody('controllers/supportController.ts', handler);
      expect(body).not.toContain('raisedBy:');
    }
  });

  it('updateStatus still enforces raiser-or-privileged, the one guarded support path', () => {
    const body = handlerBody('controllers/supportController.ts', 'updateStatus');

    expect(body).toContain('isRaiser');
    expect(body).toContain('isPrivileged');
  });

  // Batch 6: the clean contrast — notifications and search ARE scoped.
  it('getUserNotifications is still scoped to the authenticated user', () => {
    const body = handlerBody('controllers/notificationController.ts', 'getUserNotifications');

    expect(body).toContain('const userId = req.user?._id');
    expect(body).toContain('const filter: any = { userId }');
  });

  it('search is still restricted to the caller’s own projects', () => {
    const text = source('controllers/searchController.ts');

    expect(text).toContain('{ ownerId: userId }');
    expect(text).toContain('{ members: userId }');
    expect(text).toContain('projectId: { $in: projectIds }');
  });
});

describe('regression matrix — chat, socket and WebRTC authorization', () => {
  // Batch 7: join:chat has no membership check, unlike join:project.
  it('join:chat still joins without calling canJoinRoom', () => {
    const text = source('socket/socketHandlers.ts');
    const joinChat = text.slice(text.indexOf("socket.on('join:chat'"));
    const body = joinChat.slice(0, joinChat.indexOf("socket.on('leave:chat'"));

    expect(body).toContain('socket.join(room)');
    expect(body).not.toContain('canJoinRoom');
  });

  it('join:project still DOES call canJoinRoom', () => {
    const text = source('socket/socketHandlers.ts');
    const joinProject = text.slice(text.indexOf("socket.on('join:project'"));
    const body = joinProject.slice(0, joinProject.indexOf("socket.on('leave:project'"));

    expect(body).toContain('canJoinRoom');
  });

  // Batch 7: canJoinRoom still has no chat room type.
  it('canJoinRoom still handles only project and user room types', () => {
    const text = source('socket/socketAuth.ts');

    expect(text).toContain("case 'project'");
    expect(text).toContain("case 'user'");
    expect(text).not.toContain("case 'chat'");
  });

  // Batch 7: task socket events broadcast without a membership check.
  it('task:update over sockets still broadcasts using the payload projectId', () => {
    const text = source('socket/socketHandlers.ts');
    const taskUpdate = text.slice(text.indexOf("socket.on('task:update'"));
    const body = taskUpdate.slice(0, taskUpdate.indexOf("socket.on('task:create'"));

    expect(body).toContain('`project:${projectId}`');
    expect(body).not.toContain('canJoinRoom');
  });

  // Batch 7: group call join only checks that the call exists.
  it('group-call:join still admits anyone who names an existing callId', () => {
    const text = source('socket/socketHandlers.ts');
    const join = text.slice(text.indexOf("socket.on('group-call:join'"));
    const body = join.slice(0, join.indexOf("socket.on('group-call:leave'"));

    expect(body).toContain('activeGroupCalls.get(callId)');
    expect(body).not.toContain('ChatGroup');
  });

  // Batch 7: the clean contrast — HTTP chat reads are membership-scoped.
  it('getGroupMessages is still scoped to an active group the caller belongs to', () => {
    const body = handlerBody('controllers/chatController.ts', 'getGroupMessages');

    expect(body).toContain('members: userId');
    expect(body).toContain('isActive: true');
  });

  it('getGroupMemberKeys is still membership-scoped and returns public keys only', () => {
    const body = handlerBody('controllers/chatController.ts', 'getGroupMemberKeys');

    expect(body).toContain('members: userId');
    expect(body).toContain('encryptionPublicKey');
    expect(body).not.toContain('encryptionPrivateKey');
  });
});

describe('regression matrix — route-level protection sweep', () => {
  const ROUTES = path.join(SRC, 'routes');

  /** Every router file, excluding the test directory. */
  function routeFiles(): string[] {
    return fs
      .readdirSync(ROUTES)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts');
  }

  it('every router still imports authenticate', () => {
    const missing = routeFiles().filter((f) => {
      const text = fs.readFileSync(path.join(ROUTES, f), 'utf8');
      return !text.includes('authenticate');
    });

    // cron.ts is the documented exception — it is guarded by its own secret.
    expect(missing.sort()).toEqual(['cron.ts']);
  });

  it('the data-access routers still mount no project-permission middleware', () => {
    for (const file of ['audit.ts', 'notifications.ts', 'support.ts', 'user.ts', 'notes.ts']) {
      const text = fs.readFileSync(path.join(ROUTES, file), 'utf8');
      expect(text).not.toContain('checkPermission(');
    }
  });

  it('the projects router still guards edit, delete and member management', () => {
    const text = fs.readFileSync(path.join(ROUTES, 'projects.ts'), 'utf8');

    expect(text).toContain("checkPermission('canEditProject')");
    expect(text).toContain("checkPermission('canManageMembers')");
    expect(text).toContain('checkCanDeleteProject');
  });

  it('the tasks router still guards create, edit and delete', () => {
    const text = fs.readFileSync(path.join(ROUTES, 'tasks.ts'), 'utf8');

    expect(text).toContain("checkPermission('canCreateTasks')");
    expect(text).toContain('checkCanEditTask');
    expect(text).toContain('checkCanDeleteTask');
  });

  it('the reorder route still carries no permission middleware', () => {
    const text = fs.readFileSync(path.join(ROUTES, 'tasks.ts'), 'utf8');
    const line = text.split('\n').find((l) => l.includes("'/reorder'"))!;

    expect(line).toContain('reorderTasks');
    expect(line).not.toContain('checkPermission');
  });

  it('webauthnController is still wired to no router', () => {
    const referencing = routeFiles().filter((f) =>
      fs.readFileSync(path.join(ROUTES, f), 'utf8').includes('webauthn')
    );

    expect(referencing).toEqual([]);
  });
});
