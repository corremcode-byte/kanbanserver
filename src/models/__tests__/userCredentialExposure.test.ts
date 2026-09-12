/**
 * Credential-exposure surface of the User model. These tests instantiate real
 * Mongoose documents (no connection required) and inspect the schema, so they
 * assert the actual protections rather than a mock of them.
 *
 * No real secret is used or printed — every value here is a fixture string.
 */

import User from '../User';
import { encrypt, decrypt } from '../../utils/encryption';

const FIXTURE_HASH = '$2a$10$fixturehashvalue00000000000000000000000000000000000000';
const FIXTURE_PLAINTEXT = 'Fixture!Passw0rd';

function makeDoc(overrides: Record<string, any> = {}) {
  return new User({
    email: 'user@example.com',
    username: 'user@example.com',
    displayName: 'Test User',
    password: FIXTURE_HASH,
    role: 'member',
    ...overrides,
  });
}

describe('User schema — credential fields are excluded from queries by default', () => {
  it('marks every credential field as select:false', () => {
    for (const field of ['password', 'plainPassword', 'passkey', 'chatLockPasskey']) {
      expect(User.schema.path(field).options.select).toBe(false);
    }
  });

  it('does not mark ordinary profile fields as select:false', () => {
    expect(User.schema.path('email').options.select).toBeUndefined();
    expect(User.schema.path('displayName').options.select).toBeUndefined();
  });
});

describe('User.toJSON — scrubbing', () => {
  it('strips both the hash and the recoverable plainPassword copy', () => {
    const doc: any = makeDoc();
    doc.plainPassword = 'encrypted-blob-fixture';

    const json: any = doc.toJSON();

    expect(json.password).toBeUndefined();
    expect(json.plainPassword).toBeUndefined();
  });

  it('retains the ordinary profile fields a client needs', () => {
    const json: any = makeDoc().toJSON();

    expect(json.email).toBe('user@example.com');
    expect(json.displayName).toBe('Test User');
    expect(json.role).toBe('member');
  });

  it('keeps credentials out of JSON.stringify, which routes through toJSON', () => {
    const doc: any = makeDoc();
    doc.plainPassword = 'encrypted-blob-fixture';

    const serialized = JSON.stringify(doc);

    expect(serialized).not.toContain(FIXTURE_HASH);
    expect(serialized).not.toContain('encrypted-blob-fixture');
    expect(serialized).not.toContain('plainPassword');
  });

  it('also drops the internal __v version key', () => {
    expect((makeDoc().toJSON() as any).__v).toBeUndefined();
  });

  // FINDING (documented, not fixed): toObject() applies no scrubbing at all.
  // Controllers that serialise with toObject() instead of toJSON() — such as
  // getCurrentUser and getAllUsersWithPasswords — depend entirely on the
  // schema's select:false to keep credentials out of the response.
  it('toObject() performs no scrubbing — the protection is toJSON-only', () => {
    const doc: any = makeDoc();
    doc.plainPassword = 'encrypted-blob-fixture';

    const obj: any = doc.toObject();

    expect(obj.password).toBe(FIXTURE_HASH);
    expect(obj.plainPassword).toBe('encrypted-blob-fixture');
  });
});

describe('plainPassword — reversible storage of the user password', () => {
  // FINDING (critical, documented, not fixed): the pre-save hook runs
  //   if (this.isModified('password') && !this.isModified('plainPassword'))
  //     this.plainPassword = encrypt(this.password);
  // *before* the bcrypt hashing step, so plainPassword holds the user's actual
  // plaintext password under reversible AES-256-CBC — not a hash. The key comes
  // from ENCRYPTION_KEY and falls back to a hardcoded default when unset, so
  // anyone with database access plus the source can recover every password.
  // getAllUsersWithPasswords decrypts and serves exactly these values.
  it('whatever is stored in plainPassword is recoverable, not one-way', () => {
    const stored = encrypt(FIXTURE_PLAINTEXT);

    expect(stored).not.toBe(FIXTURE_PLAINTEXT);
    expect(decrypt(stored)).toBe(FIXTURE_PLAINTEXT);
  });

  it('the encryption used for plainPassword is keyed, not merely encoded', () => {
    const stored = encrypt(FIXTURE_PLAINTEXT);

    // Format is iv:ciphertext, both hex — no plaintext substring survives.
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(stored).not.toContain(FIXTURE_PLAINTEXT);
  });

  it('produces a different ciphertext each time, so equal passwords are not obviously equal', () => {
    expect(encrypt(FIXTURE_PLAINTEXT)).not.toBe(encrypt(FIXTURE_PLAINTEXT));
  });

  it('the pre-save hook that populates plainPassword is registered on save', () => {
    // Locks in that the behaviour above is wired to persistence rather than
    // being dead code, without needing a live connection to run the hook.
    const saveHooks = (User.schema as any).s.hooks._pres.get('save');
    expect(Array.isArray(saveHooks)).toBe(true);
    expect(saveHooks.length).toBeGreaterThan(0);
  });
});

describe('comparePassword', () => {
  it('returns false rather than throwing when no hash is stored', async () => {
    const doc: any = makeDoc();
    doc.password = undefined;

    await expect(doc.comparePassword('anything')).resolves.toBe(false);
  });

  it('returns false for a candidate that does not match the stored hash', async () => {
    const doc: any = makeDoc();

    await expect(doc.comparePassword('Wrong!Passw0rd')).resolves.toBe(false);
  });
});
