/**
 * Shared Files permission defaults on the User model.
 *
 * Mongoose applies a `Schema.Types.Mixed` default when it HYDRATES a stored
 * document that lacks the path, so the default chosen here is exactly what every
 * pre-existing user reads back on their next request.
 *
 * For Shared Files the correct default is CLOSED. It is a new, opt-in module on a
 * GLOBAL repository (every other gated module - auditLog, remoteWorkspace, etc. -
 * defaults closed too); only Personal Files defaults open, and only because it
 * shipped ungated. Closing it here is also what makes the client and server agree:
 * the sidebar hides `view: false`, the page shows Access Denied, and the API 403s.
 *
 * Just as important: adding `sharedFiles` must NOT disturb `personalFiles` or any
 * other module's stored or default permissions.
 */

import mongoose from 'mongoose';
import User from '../User';

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

describe('sharedFiles permission defaults', () => {
  it('denies all four actions to a user whose document predates the permission', () => {
    const user = hydrateLegacyUser({ chat: { view: true, edit: true } });

    expect(user.permissions?.modules?.sharedFiles).toEqual({
      view: false,
      create: false,
      edit: false,
      delete: false,
    });
  });

  it('denies all four actions to a brand-new user document', () => {
    const user = new User({ email: 'new@example.com', displayName: 'New', role: 'member' });

    expect(user.permissions?.modules?.sharedFiles).toEqual({
      view: false,
      create: false,
      edit: false,
      delete: false,
    });
  });

  it('survives toObject(), which is how the API serialises the current user', () => {
    // getCurrentUser does findById(...).toObject(); this is the shape the Sidebar
    // and useModulePermission receive - a DEFINED object with view:false, which
    // both hide (rather than an undefined module, which useModulePermission would
    // fail open on).
    const user = hydrateLegacyUser();

    const serialised = user.toObject() as {
      permissions?: { modules?: { sharedFiles?: Record<string, boolean> } };
    };

    expect(serialised.permissions?.modules?.sharedFiles).toBeDefined();
    expect(serialised.permissions?.modules?.sharedFiles?.view).toBe(false);
  });

  it('keeps an explicitly granted permission granted - the default never overrides stored data', () => {
    const user = hydrateLegacyUser({
      sharedFiles: { view: true, create: true, edit: false, delete: false },
    });

    expect(user.permissions?.modules?.sharedFiles).toEqual({
      view: true,
      create: true,
      edit: false,
      delete: false,
    });
  });

  it('preserves a partial stored object exactly as saved', () => {
    const user = hydrateLegacyUser({ sharedFiles: { view: true } });

    const perms = user.permissions?.modules?.sharedFiles as Record<string, boolean | undefined>;
    expect(perms.view).toBe(true);
    // Absent keys stay absent; the middleware reads them as DENIED.
    expect(perms.create).toBeUndefined();
  });

  it('exposes sharedFiles as a sibling of the other modules, not a new structure', () => {
    const user = new User({ email: 'shape@example.com', displayName: 'Shape', role: 'member' });
    const modules = user.permissions?.modules as Record<string, unknown>;

    expect(Object.keys(modules)).toContain('sharedFiles');
    expect(Object.keys(modules)).toContain('personalFiles');
    expect(typeof modules.sharedFiles).toBe('object');
  });
});

describe('personalFiles and other modules are untouched', () => {
  it('leaves personalFiles defaulting OPEN, exactly as before', () => {
    // The one module that defaults open must stay that way: flipping it would
    // revoke every existing user's private drive.
    const user = new User({ email: 'new@example.com', displayName: 'New', role: 'member' });
    expect(user.permissions?.modules?.personalFiles).toEqual({
      view: true,
      create: true,
      edit: true,
      delete: true,
    });

    const legacy = hydrateLegacyUser();
    expect(legacy.permissions?.modules?.personalFiles).toEqual({
      view: true,
      create: true,
      edit: true,
      delete: true,
    });
  });

  it('leaves the other modules’ defaults at false', () => {
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
      personalFiles: { view: true, create: false, edit: true, delete: false },
    };

    const user = hydrateLegacyUser(stored);
    const modules = user.permissions?.modules as Record<string, Record<string, boolean>>;

    expect(modules.chat).toEqual(stored.chat);
    expect(modules.projects).toEqual(stored.projects);
    expect(modules.personalFiles).toEqual(stored.personalFiles);
  });

  it('sharedFiles and personalFiles are independent objects', () => {
    // Granting one must not grant the other.
    const user = hydrateLegacyUser({
      sharedFiles: { view: true, create: true, edit: true, delete: true },
      personalFiles: { view: false, create: false, edit: false, delete: false },
    });
    const modules = user.permissions?.modules as Record<string, Record<string, boolean>>;
    expect(modules.sharedFiles.view).toBe(true);
    expect(modules.personalFiles.view).toBe(false);
  });
});
