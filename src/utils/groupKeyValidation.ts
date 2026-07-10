import nacl from 'tweetnacl';

/**
 * Validation helpers for the chat group-key rotation/distribution system
 * (see models/ChatGroup.ts ISealedKeyEntry/IKeyEpoch and chatController.ts
 * rotateGroupKey). The server never has the raw group key or any private key —
 * these checks only validate shape/membership, never any cryptographic secret.
 */

export interface KeyEpochInput {
  version?: unknown;
  memberKeys?: unknown;
  adminSealedKey?: { encryptedKey?: unknown; nonce?: unknown; senderPublicKey?: unknown };
}

export interface ValidatedKeyEpoch {
  version: number;
  memberKeys: { userId: string; encryptedKey: string; nonce: string; senderPublicKey: string }[];
  adminSealedKey?: { encryptedKey: string; nonce: string; senderPublicKey: string };
}

/**
 * Validates a client-submitted key epoch payload (used for both initial group
 * creation and rotation) against the group's actual current member list. Returns
 * the shaped, safe-to-persist epoch, or null if the payload is malformed/invalid —
 * callers should silently fall back to legacy (v1) behavior in that case rather
 * than fail the whole request, since this data is optional/additive.
 */
export function validateAndBuildKeyEpoch(
  input: KeyEpochInput | undefined | null,
  version: number,
  currentMemberIds: string[]
): ValidatedKeyEpoch | null {
  if (!input || typeof input !== 'object') return null;
  if (!Array.isArray(input.memberKeys)) return null;

  const entries = input.memberKeys as SealedKeyEntryInput[];
  if (!entries.every(isValidSealedKeyEntryShape)) return null;
  if (!memberKeysMatchGroupMembers(entries, currentMemberIds)) return null;

  let adminSealedKey: ValidatedKeyEpoch['adminSealedKey'];
  if (input.adminSealedKey) {
    const a = input.adminSealedKey;
    if (
      typeof a.encryptedKey === 'string' &&
      a.encryptedKey.length > 0 &&
      typeof a.nonce === 'string' &&
      a.nonce.length > 0 &&
      isValidNaclPublicKeyB64(a.senderPublicKey)
    ) {
      adminSealedKey = {
        encryptedKey: a.encryptedKey,
        nonce: a.nonce,
        senderPublicKey: a.senderPublicKey as string
      };
    } else {
      return null;
    }
  }

  return {
    version,
    memberKeys: entries.map((e) => ({
      userId: e.userId as string,
      encryptedKey: e.encryptedKey as string,
      nonce: e.nonce as string,
      senderPublicKey: e.senderPublicKey as string
    })),
    adminSealedKey
  };
}

export function isValidNaclPublicKeyB64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    // Reject if the string wasn't valid base64 to begin with (round-trip check)
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return false;
    return bytes.length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

export interface SealedKeyEntryInput {
  userId?: unknown;
  encryptedKey?: unknown;
  nonce?: unknown;
  senderPublicKey?: unknown;
}

/** Shape-validates a single sealed key entry; does not touch its ciphertext. */
export function isValidSealedKeyEntryShape(entry: SealedKeyEntryInput): boolean {
  return (
    typeof entry.userId === 'string' &&
    entry.userId.length > 0 &&
    typeof entry.encryptedKey === 'string' &&
    entry.encryptedKey.length > 0 &&
    typeof entry.nonce === 'string' &&
    entry.nonce.length > 0 &&
    isValidNaclPublicKeyB64(entry.senderPublicKey)
  );
}

/**
 * A rotation payload must only seal the new key to users who are actually current
 * members of the group — prevents a compromised/malicious client from planting a
 * sealed copy for an outsider.
 */
export function memberKeysMatchGroupMembers(
  memberKeys: SealedKeyEntryInput[],
  currentMemberIds: string[]
): boolean {
  const memberSet = new Set(currentMemberIds);
  return memberKeys.every((entry) => typeof entry.userId === 'string' && memberSet.has(entry.userId));
}
