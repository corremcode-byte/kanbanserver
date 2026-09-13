import { validatePassword } from '../validation';

/** Meets every complexity rule; used as the base for boundary cases. */
const STRONG = 'Str0ng!Passw0rd';

describe('validatePassword — accepted passwords', () => {
  it('accepts a password meeting every complexity rule', () => {
    expect(validatePassword(STRONG)).toEqual({ valid: true, errors: [] });
  });

  it('accepts every character in the documented special-character set', () => {
    for (const special of ['!', '@', '#', '$', '%', '^', '&', '*']) {
      expect(validatePassword(`Abcdefg1${special}`)).toEqual({ valid: true, errors: [] });
    }
  });
});

describe('validatePassword — length boundaries', () => {
  it('rejects 7 characters and accepts exactly 8', () => {
    expect(validatePassword('Abc123!').errors).toContain('At least 8 characters required');
    const atMinimum = validatePassword('Abc123!d');
    expect(atMinimum.valid).toBe(true);
  });

  it('accepts exactly 64 characters and rejects 65', () => {
    const filler = 'a'.repeat(64 - 'Abc123!'.length);
    const at64 = `Abc123!${filler}`;
    expect(at64).toHaveLength(64);
    expect(validatePassword(at64).valid).toBe(true);

    const at65 = `${at64}a`;
    expect(validatePassword(at65).errors).toContain('Maximum 64 characters allowed');
    expect(validatePassword(at65).valid).toBe(false);
  });

  it('reports an empty password as invalid with multiple complexity errors', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.errors).toContain('At least 8 characters required');
  });
});

describe('validatePassword — missing complexity classes', () => {
  it.each([
    ['no uppercase', 'str0ng!passw0rd', 'At least one uppercase letter (A-Z)'],
    ['no lowercase', 'STR0NG!PASSW0RD', 'At least one lowercase letter (a-z)'],
    ['no digit', 'Strong!Password', 'At least one number (0-9)'],
    ['no special character', 'Str0ngPassw0rd', 'At least one special character (!@#$%^&*)'],
  ])('rejects a password with %s', (_label, password, expectedError) => {
    const result = validatePassword(password);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expectedError);
  });

  it('accumulates every violated rule rather than short-circuiting on the first', () => {
    const result = validatePassword('abc');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'At least 8 characters required',
        'At least one uppercase letter (A-Z)',
        'At least one number (0-9)',
        'At least one special character (!@#$%^&*)',
      ])
    );
  });

  it('does not accept an unlisted punctuation mark as the special character', () => {
    const result = validatePassword('Abcdefg1(');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one special character (!@#$%^&*)');
  });
});

describe('validatePassword — whitespace', () => {
  it('rejects any whitespace — inner space, tab or leading space', () => {
    for (const password of ['Str0ng! Passw0rd', 'Str0ng!\tPassw0rd', ' Str0ng!Passw0rd']) {
      const result = validatePassword(password);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Must not contain spaces');
    }
  });
});

describe('validatePassword — common passwords', () => {
  it('rejects blocklisted passwords that nonetheless satisfy every complexity rule', () => {
    for (const password of ['Password123!', 'Qwerty123!', 'Admin123!', 'Abc12345!']) {
      const result = validatePassword(password);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password is too common — choose something more unique');
    }
  });

  it('matches the common-password list case-insensitively', () => {
    expect(validatePassword('PASSWORD123!').errors).toContain(
      'Password is too common — choose something more unique'
    );
  });
});

describe('validatePassword — personal-information reuse', () => {
  it('rejects a password identical to the email address', () => {
    const result = validatePassword('User@Example1', 'user@example1');
    expect(result.errors).toContain('Password must not be the same as your email address');
  });

  it('rejects a password identical to the email local part', () => {
    const result = validatePassword('Johndoe1!', 'johndoe1!@example.com');
    expect(result.errors).toContain('Password must not be the same as your email address');
  });

  it('rejects a password that merely starts with a long email local part', () => {
    const result = validatePassword('Jonathansmith1!', 'jonathansmith@example.com');
    expect(result.errors).toContain('Password must not be the same as your email address');
  });

  it('allows a strong password that only shares a short local part as a prefix', () => {
    // 'bob' is under the 8-character threshold, so the prefix rule must not fire.
    const result = validatePassword('Bob!Str0ngPass', 'bob@example.com');
    expect(result.valid).toBe(true);
  });

  it('rejects a password matching the display name with spaces stripped', () => {
    const result = validatePassword('Jonathansmith1!', undefined, 'Jonathan Smith1!');
    expect(result.errors).toContain('Password must not be the same as your name');
  });

  it('skips the identity checks entirely when email and displayName are omitted', () => {
    const result = validatePassword(STRONG);
    expect(result.errors).toHaveLength(0);
  });
});
