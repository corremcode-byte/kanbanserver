import nacl from 'tweetnacl';

/**
 * Field-level encryption for Task description / comment text — server-side only.
 * Reuses the exact same primitive as chat message encryption (kanbanclient's
 * encryptionService.ts: nacl.secretbox + a deterministic key derived from an id),
 * but unlike chat's client-side "key derived from groupId alone" (computable by
 * anyone who knows the id), the key here also mixes in a server-only secret so a
 * task's ciphertext can only be decrypted by this backend, never by someone who
 * merely learns a taskId. This is required because task descriptions/comments are
 * meant to be readable by whole project teams via the API — the server, not any
 * single client, is the one that encrypts on write and decrypts on read.
 */

const ENCRYPTED_PREFIX = 'enc:v1:';

function getServerSecret(): string {
  return process.env.TASK_FIELD_ENCRYPTION_SECRET || process.env.JWT_SECRET || 'kanban-task-field-fallback-secret';
}

/** Same XOR-mixing formula as encryptionService.ts's generateDeterministicKey,
 *  seeded with SERVER_SECRET + taskId instead of groupId alone. */
function deriveKey(taskId: string): Uint8Array {
  const seed = `${getServerSecret()}:${taskId}`;
  const data = new TextEncoder().encode(seed);
  const keyBytes = new Uint8Array(nacl.secretbox.keyLength);
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] = data[i % data.length] ^ (i * 7);
  }
  return keyBytes;
}

/** Encrypts plaintext for storage, keyed by the owning task's id. Falsy input
 *  (undefined/null/empty string) passes through unchanged — nothing to encrypt. */
export function encryptField(plaintext: string | undefined | null, taskId: string): string | undefined {
  if (!plaintext) return plaintext ?? undefined;
  const key = deriveKey(taskId);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);
  const encrypted = nacl.secretbox(messageBytes, nonce, key);
  const nonceB64 = Buffer.from(nonce).toString('base64');
  const contentB64 = Buffer.from(encrypted).toString('base64');
  return `${ENCRYPTED_PREFIX}${nonceB64}:${contentB64}`;
}

/** Decrypts a value produced by encryptField. Values that aren't in the encrypted
 *  format (legacy plaintext, or empty) pass through unchanged — this is the
 *  backward-compatibility check for pre-existing plaintext descriptions/comments. */
export function decryptField(value: string | undefined | null, taskId: string): string | undefined {
  if (!value) return value ?? undefined;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // legacy plaintext
  try {
    const [nonceB64, contentB64] = value.slice(ENCRYPTED_PREFIX.length).split(':');
    if (!nonceB64 || !contentB64) return value;
    const key = deriveKey(taskId);
    const nonce = new Uint8Array(Buffer.from(nonceB64, 'base64'));
    const encrypted = new Uint8Array(Buffer.from(contentB64, 'base64'));
    const decrypted = nacl.secretbox.open(encrypted, nonce, key);
    if (!decrypted) return value; // wrong key / corrupted ciphertext — fail safe, never crash
    return new TextDecoder().decode(decrypted);
  } catch {
    return value;
  }
}

interface TaskLikeForDecryption {
  _id: unknown;
  description?: string;
  comments?: Array<{ text?: string }>;
}

/** Decrypts description + every comment's text on a task-like object, in place.
 *  Safe on both Mongoose lean objects and hydrated documents; a no-op for any
 *  field that's already plaintext (legacy data). */
export function decryptTaskFields<T extends TaskLikeForDecryption>(task: T): T {
  const taskId = String(task._id);
  if (task.description) task.description = decryptField(task.description, taskId);
  if (Array.isArray(task.comments)) {
    task.comments.forEach((c) => {
      if (c.text) c.text = decryptField(c.text, taskId);
    });
  }
  return task;
}
