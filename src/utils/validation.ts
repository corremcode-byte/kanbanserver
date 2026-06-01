// ── Password validation ───────────────────────────────────────────────────────

const COMMON_PASSWORDS = [
  'password', 'password1', 'password12', 'password123', 'password123!',
  'Password1', 'Password12', 'Password123', 'Password123!',
  '12345678', '123456789', '1234567890',
  'qwerty123', 'Qwerty123', 'qwerty123!', 'Qwerty123!',
  'admin123', 'Admin123', 'admin123!', 'Admin123!',
  'letmein1', 'welcome1', 'Welcome1!', 'monkey123',
  'dragon123', 'master123', 'superman1', 'batman123',
  'iloveyou1', 'sunshine1', 'princess1', 'football1',
  'trustno1', 'abc12345', 'Abc12345!',
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(
  password: string,
  email?: string,
  displayName?: string,
): ValidationResult {
  const errors: string[] = [];

  if (password.length < 8)  errors.push('At least 8 characters required');
  if (password.length > 64) errors.push('Maximum 64 characters allowed');
  if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter (A-Z)');
  if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter (a-z)');
  if (!/[0-9]/.test(password)) errors.push('At least one number (0-9)');
  if (!/[!@#$%^&*]/.test(password)) errors.push('At least one special character (!@#$%^&*)');
  if (/\s/.test(password)) errors.push('Must not contain spaces');

  if (COMMON_PASSWORDS.some(cp => password.toLowerCase() === cp.toLowerCase())) {
    errors.push('Password is too common — choose something more unique');
  }

  if (email) {
    const lower = password.toLowerCase();
    const emailLower = email.toLowerCase();
    const local = emailLower.split('@')[0];
    // Block only if password IS the email, or IS the local part, or the local part is very long and dominates the password
    if (lower === emailLower || lower === local || (local.length >= 8 && lower.startsWith(local))) {
      errors.push('Password must not be the same as your email address');
    }
  }

  if (displayName) {
    const lower = password.toLowerCase();
    const nameLower = displayName.toLowerCase().replace(/\s+/g, '');
    // Block only if password IS the name or the full name dominates the password
    if (lower === nameLower || (nameLower.length >= 8 && lower.startsWith(nameLower))) {
      errors.push('Password must not be the same as your name');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Passkey validation ────────────────────────────────────────────────────────

export function validatePasskey(passkey: string): ValidationResult {
  const errors: string[] = [];

  if (!/^\d{6}$/.test(passkey)) {
    errors.push('Must be exactly 6 digits (0–9 only)');
    return { valid: false, errors };
  }

  // All identical digits: 000000, 111111 …
  if (/^(\d)\1{5}$/.test(passkey)) {
    errors.push('Cannot be all identical digits (e.g. 000000, 111111)');
  }

  // Sequential ascending: 123456, 234567 …
  const digits = passkey.split('').map(Number);
  const isAscending  = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const isDescending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (isAscending || isDescending) {
    errors.push('Cannot be a sequential pattern (e.g. 123456, 654321)');
  }

  // Repeating 2-digit block: 121212, 010101
  if (/^(\d{2})\1\1$/.test(passkey)) {
    errors.push('Cannot be a repeating pattern (e.g. 121212, 010101)');
  }

  // Repeating 3-digit block: 123123
  if (/^(\d{3})\1$/.test(passkey)) {
    errors.push('Cannot be a repeating pattern (e.g. 123123)');
  }

  // Repeating pairs: 112233, 445566
  if (/^(\d)\1(\d)\2(\d)\3$/.test(passkey)) {
    errors.push('Cannot be a repeating-pairs pattern (e.g. 112233, 445566)');
  }

  return { valid: errors.length === 0, errors };
}
