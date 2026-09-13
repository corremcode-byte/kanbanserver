/**
 * Personal Files permission defaults on the User model.
 *
 * The reason this file exists: Mongoose applies a `Schema.Types.Mixed` default when
 * it HYDRATES a stored document that lacks the path - not only when creating one. So
 * the default chosen for a newly introduced permission is exactly what every
 * pre-existing user reads back on their next request. Had `personalFiles` been given
 * the `{ view: false }` default the other modules use, introducing it would have
 * silently revoked every existing user's access to their own private drive.
 *
 * These tests pin that behaviour so the default cannot be "tidied up" to match the
 * others without the consequence being visible.
 *
 * No database connection: hydrate() reproduces the read path faithfully.
 */

import mongoose from 'mongoose';
import User from '../User';

/** A stored document as it exists for a user created before this permission. */
function hydrateLegacyUser(storedModules: Record<string, unknown> = {}) {
  return User.hydrate({
    _id: new mongoose.Types.ObjectId(),
    email: 'legacy@example.com',
    displayName: 'Legacy User',
    role: 'member',
    isActive: true,
    permissions: { modules: storedModules },
  } as never);
}

describe('personalFiles permission defaults', () => {
  it('grants all four actions to a user whose document predates the permission', () => {
    const user = hydrateLegacyUser({ chat: { view: true, edit: true } });

    const perms = user.permissions?.modules?.personalFiles;

    expect(perms).toEqual({ view: true, create: true, edit: true, delete: true });
  });

  it('grants all four actions to a brand-new user document', () => {
    const user = new User({ email: 'new@example.com', displayName: 'New', role: 'member' });

    expect(user.permissions?.modules?.personalFiles).toEqual({
      view: true,
      create: true,
      edit: true,
      delete: true,
    });
  });

  it('survives toObject(), which is how the API serialises the current user', () => {
    // getCurrentUser does findById(...).toObject(), so this is the exact shape the
    // client's useModulePermission hook and the Sidebar filter receive.
    const user = hydrateLegacyUser();

    const serialised = user.toObject() as {
      permissions?: { modules?: { personalFiles?: Record<string, boolean> } };
    };

    expect(serialised.permissions?.modules?.personalFiles?.view).toBe(true);
  });

  it('keeps an explicitly revoked permission revoked - the default never overrides stored data', () => {
    const user = hydrateLegacyUser({
      personalFiles: { view: false, create: false, edit: false, delete: false },
    });

    expect(user.permissions?.modules?.personalFiles).toEqual({
      view: false,
      create: false,
      edit: false,
      delete: false,
    });
  });

  it('preserves a partial stored object exactly as saved', () => {
    const user = hydrateLegacyUser({ personalFiles: { view: true, create: false } });

    const perms = user.permissions?.modules?.personalFiles as Record<string, boolean | undefined>;
    expect(perms.view).toBe(true);
    expect(perms.create).toBe(false);
    // Absent keys stay absent; the middleware reads them as granted.
    expect(perms.edit).toBeUndefined();
  });
});

describe('unrelated permissions are untouched', () => {
  it('leaves the other modules’ defaults at false', () => {
    // Personal Files defaults open BECAUSE it shipped ungated. That reasoning does
    // not extend to anything else, so the other modules must stay closed.
    const user = new User({ email: 'new@example.com', displayName: 'New', role: 'member' });
    const modules = user.permissions?.modules as Record<string, Record<string, boolean>>;

    for (const name of [
      'dashboard',
      'myTasks',
      'projects',
      'chat',
      'profile',
      'userManagement',
      'performance',
      'auditLog',
      'remoteWorkspace',
    ]) {
      expect(modules[name].view).toBe(false);
    }
    expect(modules.dataDeletion.execute).toBe(false);
  });

  it('does not disturb a stored user’s existing module permissions', () => {
    const stored = {
      chat: { view: true, edit: true, sendMessages: true },
      projects: { view: true, createProjects: true },
      userManagement: { view: false, edit: false },
    };

    const user = hydrateLegacyUser(stored);
    const modules = user.permissions?.modules as Record<string, Record<string, boolean>>;

    expect(modules.chat).toEqual(stored.chat);
    expect(modules.projects).toEqual(stored.projects);
    expect(modules.userManagement).toEqual(stored.userManagement);
  });

  it('exposes personalFiles as a sibling of the other modules, not a new structure', () => {
    // Same shape, same place - this is an addition to the existing permission
    // matrix rather than a parallel system.
    const user = new User({ email: 'shape@example.com', displayName: 'Shape', role: 'member' });
    const modules = user.permissions?.modules as Record<string, unknown>;

    expect(Object.keys(modules)).toContain('personalFiles');
    expect(typeof modules.personalFiles).toBe('object');
  });
});
