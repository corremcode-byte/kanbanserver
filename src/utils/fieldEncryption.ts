import nacl from 'tweetnacl';

/**
 * Field-level encryption for Task/Project/Note/SupportTicket/Message text and
 * attachment-url fields — server-side only. Reuses the exact same primitive as
 * chat message encryption (kanbanclient's
 * encryptionService.ts: nacl.secretbox + a deterministic key derived from an id),
 * but unlike chat's client-side "key derived from groupId alone" (computable by
 * anyone who knows the id), the key here also mixes in a server-only secret so a
 * document's ciphertext can only be decrypted by this backend, never by someone who
 * merely learns its id. This is required because these fields are meant to be
 * readable by whole project teams / the document owner via the API — the server,
 * not any single client, is the one that encrypts on write and decrypts on read.
 * Every field is keyed by its own owning document's `_id` (e.g. a task's comments
 * and subtask titles are keyed by the task's id, a ticket's reply messages by the
 * ticket's id — never by the sub-item's own id).
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
  title?: string;
  description?: string;
  comments?: Array<{ text?: string }>;
  subtasks?: Array<{ title?: string; attachments?: Array<{ url?: string }> }>;
  attachments?: Array<{ url?: string }>;
  // May be a populated Project doc/subset ({ _id, name, ... }) or a plain ObjectId/string — only
  // decrypted when it's actually populated with a `name` (i.e. someone did .populate('projectId', 'name...')).
  projectId?: { _id?: unknown; id?: unknown; name?: string } | unknown;
}

/** Decrypts title, description, every comment's text, every subtask's title, and
 *  every attachment's url (top-level and per-subtask) on a task-like object, in
 *  place — all keyed by the *task's* own id, never a subtask's/attachment's own id.
 *  Also decrypts the populated project's `name` when `projectId` was populated
 *  (keyed by the *project's* own id, not the task's). Safe on both Mongoose lean
 *  objects and hydrated documents; a no-op for any field that's already plaintext
 *  (legacy data). */
export function decryptTaskFields<T extends TaskLikeForDecryption>(task: T): T {
  const taskId = String(task._id);
  if (task.title) task.title = decryptField(task.title, taskId);
  if (task.description) task.description = decryptField(task.description, taskId);
  if (Array.isArray(task.comments)) {
    task.comments.forEach((c) => {
      if (c.text) c.text = decryptField(c.text, taskId);
    });
  }
  if (Array.isArray(task.subtasks)) {
    task.subtasks.forEach((s) => {
      if (s.title) s.title = decryptField(s.title, taskId);
      if (Array.isArray(s.attachments)) {
        s.attachments.forEach((a) => {
          if (a.url) a.url = decryptField(a.url, taskId);
        });
      }
    });
  }
  if (Array.isArray(task.attachments)) {
    task.attachments.forEach((a) => {
      if (a.url) a.url = decryptField(a.url, taskId);
    });
  }
  const proj = task.projectId as { _id?: unknown; id?: unknown; name?: string } | null | undefined;
  if (proj && typeof proj === 'object' && proj.name) {
    const projectId = String(proj._id ?? proj.id ?? '');
    if (projectId) proj.name = decryptField(proj.name, projectId);
  }
  return task;
}

interface ProjectLikeForDecryption {
  _id: unknown;
  name?: string;
  description?: string;
}

/** Decrypts name + description on a project-like object, in place. Same
 *  backward-compatible/no-op-on-plaintext behavior as decryptTaskFields. */
export function decryptProjectFields<T extends ProjectLikeForDecryption>(project: T): T {
  const projectId = String(project._id);
  if (project.name) project.name = decryptField(project.name, projectId);
  if (project.description) project.description = decryptField(project.description, projectId);
  return project;
}

interface NoteLikeForDecryption {
  _id: unknown;
  title?: string;
  content?: string;
}

/** Decrypts title + content on a note-like object, in place. `description` (the
 *  legacy plaintext field) is intentionally left untouched — out of scope. */
export function decryptNoteFields<T extends NoteLikeForDecryption>(note: T): T {
  const noteId = String(note._id);
  if (note.title) note.title = decryptField(note.title, noteId);
  if (note.content) note.content = decryptField(note.content, noteId);
  return note;
}

interface SupportTicketLikeForDecryption {
  _id: unknown;
  title?: string;
  description?: string;
  replies?: Array<{ message?: string; attachments?: Array<{ url?: string }> }>;
  attachments?: Array<{ url?: string }>;
}

/** Decrypts title, description, every reply's message, and every attachment's url
 *  (top-level and per-reply) on a support-ticket-like object, in place. Replies
 *  and their attachments are keyed by the parent ticket's own id — same pattern
 *  as Task comments (keyed by the parent task, not each comment's/reply's own id). */
export function decryptSupportTicketFields<T extends SupportTicketLikeForDecryption>(ticket: T): T {
  const ticketId = String(ticket._id);
  if (ticket.title) ticket.title = decryptField(ticket.title, ticketId);
  if (ticket.description) ticket.description = decryptField(ticket.description, ticketId);
  if (Array.isArray(ticket.replies)) {
    ticket.replies.forEach((r) => {
      if (r.message) r.message = decryptField(r.message, ticketId);
      if (Array.isArray(r.attachments)) {
        r.attachments.forEach((a) => {
          if (a.url) a.url = decryptField(a.url, ticketId);
        });
      }
    });
  }
  if (Array.isArray(ticket.attachments)) {
    ticket.attachments.forEach((a) => {
      if (a.url) a.url = decryptField(a.url, ticketId);
    });
  }
  return ticket;
}

interface MessageLikeForDecryption {
  _id: unknown;
  attachments?: Array<{ fileUrl?: string; thumbnailUrl?: string }>;
  // A populated reply-to message is itself a full message with its own id — its
  // attachments must be decrypted keyed by ITS OWN id, not the current message's.
  replyTo?: MessageLikeForDecryption | unknown;
}

/** Decrypts every attachment's fileUrl/thumbnailUrl on a chat-message-like object,
 *  in place, keyed by the message's own id. If `replyTo` is populated (a full
 *  message sub-document, not just an id), it's recursively decrypted keyed by its
 *  own id. */
export function decryptMessageFields<T extends MessageLikeForDecryption>(message: T): T {
  const messageId = String(message._id);
  if (Array.isArray(message.attachments)) {
    message.attachments.forEach((a) => {
      if (a.fileUrl) a.fileUrl = decryptField(a.fileUrl, messageId);
      if (a.thumbnailUrl) a.thumbnailUrl = decryptField(a.thumbnailUrl, messageId);
    });
  }
  const reply = message.replyTo as MessageLikeForDecryption | null | undefined;
  if (reply && typeof reply === 'object' && '_id' in reply) {
    decryptMessageFields(reply);
  }
  return message;
}
