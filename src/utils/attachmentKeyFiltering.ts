/**
 * Security boundary for Message.attachmentKeys (see models/Message.ts). Each
 * entry is one user's sealed (nacl.box) copy of an attachment's random AES file
 * key — a Message document holds one entry per (attachmentId, current group
 * member) pair, but a given API response must only ever contain the REQUESTING
 * user's own entries. Leaking another member's entry doesn't hand over the file
 * itself (the attacker still lacks that member's NaCl private key), but it's an
 * unnecessary widening of exposure and must never happen.
 *
 * Call this at every place a Message (or a message-shaped plain object) is
 * about to be returned to a client or emitted over a socket — the same set of
 * call sites that already call decryptMessageFields for the (much weaker,
 * server-reversible) fileUrl/thumbnailUrl obfuscation.
 */

interface AttachmentKeyEntryLike {
  attachmentId?: unknown;
  userId?: unknown;
  encryptedKey?: unknown;
  nonce?: unknown;
  senderPublicKey?: unknown;
}

interface MessageLike {
  attachmentKeys?: AttachmentKeyEntryLike[];
  replyTo?: MessageLike | unknown;
}

function entryBelongsToUser(entry: AttachmentKeyEntryLike, userId: string): boolean {
  const owner = entry.userId as { toString?: () => string } | string | undefined;
  if (!owner) return false;
  return (typeof owner === 'string' ? owner : owner.toString?.()) === userId;
}

/**
 * Mutates `message` (and, if populated, its `replyTo`) in place, keeping only
 * `attachmentKeys` entries belonging to `userId`. Safe to call on a Mongoose
 * document (post .toObject()/lean) or a plain object. No-op if the field is
 * absent/not an array (every pre-existing message before this feature). Use
 * this for single-recipient responses (an HTTP response to the requesting
 * user themselves). For a payload that will be sent to MULTIPLE different
 * users (e.g. a per-member Socket.IO broadcast loop), use the non-mutating
 * pickAttachmentKeysForUser below instead — mutating a shared object across
 * loop iterations would leave only the first recipient's entries intact.
 */
export function filterAttachmentKeysForUser(message: MessageLike | null | undefined, userId: string): void {
  if (!message || !userId) return;

  if (Array.isArray(message.attachmentKeys)) {
    message.attachmentKeys = message.attachmentKeys.filter((entry) => entryBelongsToUser(entry, userId));
  }

  if (message.replyTo && typeof message.replyTo === 'object') {
    filterAttachmentKeysForUser(message.replyTo as MessageLike, userId);
  }
}

/** Non-mutating: returns a new array containing only `userId`'s entries. Safe
 *  to call once per recipient against the same shared source array when
 *  building distinct per-recipient broadcast payloads. */
export function pickAttachmentKeysForUser<T extends AttachmentKeyEntryLike>(
  entries: T[] | null | undefined,
  userId: string
): T[] {
  if (!Array.isArray(entries) || !userId) return [];
  return entries.filter((entry) => entryBelongsToUser(entry, userId));
}

/** Strips attachmentKeys entirely — used for the super-admin viewer, which has
 *  no NaCl private key that could ever use these and should never receive them. */
export function stripAttachmentKeys(message: MessageLike | null | undefined): void {
  if (!message) return;
  if (Array.isArray(message.attachmentKeys)) {
    message.attachmentKeys = [];
  }
  if (message.replyTo && typeof message.replyTo === 'object') {
    stripAttachmentKeys(message.replyTo as MessageLike);
  }
}
