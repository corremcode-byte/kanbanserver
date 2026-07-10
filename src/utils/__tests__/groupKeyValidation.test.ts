import nacl from 'tweetnacl';
import {
  isValidNaclPublicKeyB64,
  isValidSealedKeyEntryShape,
  memberKeysMatchGroupMembers,
  validateAndBuildKeyEpoch,
} from '../groupKeyValidation';

function makePublicKeyB64(): string {
  return Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
}

describe('groupKeyValidation', () => {
  describe('isValidNaclPublicKeyB64', () => {
    it('accepts a real 32-byte NaCl public key encoded as base64', () => {
      expect(isValidNaclPublicKeyB64(makePublicKeyB64())).toBe(true);
    });

    it('rejects non-base64, wrong-length, and non-string input', () => {
      expect(isValidNaclPublicKeyB64('not-base64-!!!')).toBe(false);
      expect(isValidNaclPublicKeyB64(Buffer.from('too short').toString('base64'))).toBe(false);
      expect(isValidNaclPublicKeyB64('')).toBe(false);
      expect(isValidNaclPublicKeyB64(undefined)).toBe(false);
      expect(isValidNaclPublicKeyB64(12345 as unknown as string)).toBe(false);
    });
  });

  describe('isValidSealedKeyEntryShape', () => {
    it('accepts a well-formed entry', () => {
      expect(
        isValidSealedKeyEntryShape({
          userId: 'user-1',
          encryptedKey: 'ZW5jcnlwdGVk',
          nonce: 'bm9uY2U=',
          senderPublicKey: makePublicKeyB64(),
        })
      ).toBe(true);
    });

    it('rejects an entry missing any required field', () => {
      const base = { userId: 'user-1', encryptedKey: 'x', nonce: 'y', senderPublicKey: makePublicKeyB64() };
      expect(isValidSealedKeyEntryShape({ ...base, userId: undefined })).toBe(false);
      expect(isValidSealedKeyEntryShape({ ...base, encryptedKey: '' })).toBe(false);
      expect(isValidSealedKeyEntryShape({ ...base, senderPublicKey: 'not-a-key' })).toBe(false);
    });
  });

  describe('memberKeysMatchGroupMembers', () => {
    it('accepts entries that are all real current members', () => {
      const entries = [{ userId: 'a' }, { userId: 'b' }];
      expect(memberKeysMatchGroupMembers(entries, ['a', 'b', 'c'])).toBe(true);
    });

    it('rejects a sealed entry for a non-member (prevents planting a key for an outsider)', () => {
      const entries = [{ userId: 'a' }, { userId: 'intruder' }];
      expect(memberKeysMatchGroupMembers(entries, ['a', 'b'])).toBe(false);
    });
  });

  describe('validateAndBuildKeyEpoch', () => {
    const alicePk = makePublicKeyB64();
    const bobPk = makePublicKeyB64();
    const adminPk = makePublicKeyB64();

    it('builds a valid epoch from a well-formed payload', () => {
      const result = validateAndBuildKeyEpoch(
        {
          memberKeys: [
            { userId: 'alice', encryptedKey: 'ek1', nonce: 'n1', senderPublicKey: alicePk },
            { userId: 'bob', encryptedKey: 'ek2', nonce: 'n2', senderPublicKey: alicePk },
          ],
          adminSealedKey: { encryptedKey: 'ek3', nonce: 'n3', senderPublicKey: adminPk },
        },
        2,
        ['alice', 'bob']
      );

      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
      expect(result!.memberKeys).toHaveLength(2);
      expect(result!.adminSealedKey?.senderPublicKey).toEqual(adminPk);
    });

    it('rejects a payload sealing to someone who is not a current member', () => {
      const result = validateAndBuildKeyEpoch(
        {
          memberKeys: [{ userId: 'mallory', encryptedKey: 'ek', nonce: 'n', senderPublicKey: alicePk }],
        },
        2,
        ['alice', 'bob']
      );
      expect(result).toBeNull();
    });

    it('rejects malformed adminSealedKey shapes', () => {
      const result = validateAndBuildKeyEpoch(
        {
          memberKeys: [{ userId: 'alice', encryptedKey: 'ek', nonce: 'n', senderPublicKey: alicePk }],
          adminSealedKey: { encryptedKey: 'ek', nonce: 'n', senderPublicKey: 'not-a-real-key' },
        },
        2,
        ['alice']
      );
      expect(result).toBeNull();
    });

    it('returns null for missing/malformed input rather than throwing', () => {
      expect(validateAndBuildKeyEpoch(undefined, 2, ['alice'])).toBeNull();
      expect(validateAndBuildKeyEpoch({} as any, 2, ['alice'])).toBeNull();
      expect(() => validateAndBuildKeyEpoch(null, 2, [])).not.toThrow();
    });

    it('unused public key from setup is at least a valid key (sanity check on test helper)', () => {
      expect(isValidNaclPublicKeyB64(bobPk)).toBe(true);
    });
  });
});
