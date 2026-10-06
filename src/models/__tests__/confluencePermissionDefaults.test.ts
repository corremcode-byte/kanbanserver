/**
 * Confluence permission defaults on the User model.
 *
 * Confluence is a new opt-in module, so its default is CLOSED — both for brand
 * new users and for every pre-existing user document (Mongoose applies a Mixed
 * default when hydrating a stored document that lacks the path). Adding it must
 * not disturb any other module's stored or default permissions.
 */

import mongoose from 'mongoose';
import User from '../User';

const CLOSED = { view: false, create: false, edit: false, comment: false, publish: false, delete: false };

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

describe('confluence permission defaults', () => {
  it('denies every action to a user whose document predates the permission', () => {
    const user = hydrateLegacyUser({ chat: { view: true } });
    expect(user.permissions?.modules?.confluence).toEqual(CLOSED);
  });

  it('denies every action to a brand-new user document', () => {
    const user = new User({ email: 'new@example.com', displayName: 'New', role: 'member' });
    expect(user.permissions?.modules?.confluence).toEqual(CLOSED);
  });

  it('keeps an explicitly granted permission granted', () => {
    const granted = { view: true, create: true, edit: false, comment: true, publish: false, delete: false };
    const user = hydrateLegacyUser({ confluence: granted });
    expect(user.permissions?.modules?.confluence).toEqual(granted);
  });

  it('does not change the Shared Files or Personal Files defaults', () => {
    const user = hydrateLegacyUser();
    expect(user.permissions?.modules?.sharedFiles).toEqual({ view: false, create: false, edit: false, delete: false });
    expect(user.permissions?.modules?.personalFiles).toEqual({ view: true, create: true, edit: true, delete: true });
  });
});
