import { filterAttachmentKeysForUser, pickAttachmentKeysForUser, stripAttachmentKeys } from '../attachmentKeyFiltering';

function makeEntry(attachmentId: string, userId: string) {
  return { attachmentId, userId, encryptedKey: 'ZW5jcnlwdGVk', nonce: 'bm9uY2U=', senderPublicKey: 'c2VuZGVy' };
}

describe('attachmentKeyFiltering', () => {
  describe('pickAttachmentKeysForUser', () => {
    it('returns only the entries belonging to the given user', () => {
      const entries = [makeEntry('att-1', 'alice'), makeEntry('att-1', 'bob'), makeEntry('att-2', 'alice')];
      const picked = pickAttachmentKeysForUser(entries, 'alice');
      expect(picked).toHaveLength(2);
      expect(picked.every((e) => e.userId === 'alice')).toBe(true);
    });

    it('does not mutate the source array', () => {
      const entries = [makeEntry('att-1', 'alice'), makeEntry('att-1', 'bob')];
      const before = entries.length;
      pickAttachmentKeysForUser(entries, 'alice');
      expect(entries).toHaveLength(before);
    });

    it('returns an empty array for a user with no entries', () => {
      const entries = [makeEntry('att-1', 'alice')];
      expect(pickAttachmentKeysForUser(entries, 'charlie')).toEqual([]);
    });

    it('handles missing/undefined input safely', () => {
      expect(pickAttachmentKeysForUser(undefined, 'alice')).toEqual([]);
      expect(pickAttachmentKeysForUser(null, 'alice')).toEqual([]);
      expect(pickAttachmentKeysForUser([], '')).toEqual([]);
    });
  });

  describe('filterAttachmentKeysForUser', () => {
    it('mutates message.attachmentKeys down to only the given user\'s entries', () => {
      const message: any = {
        attachmentKeys: [makeEntry('att-1', 'alice'), makeEntry('att-1', 'bob'), makeEntry('att-2', 'bob')],
      };
      filterAttachmentKeysForUser(message, 'bob');
      expect(message.attachmentKeys).toHaveLength(2);
      expect(message.attachmentKeys.every((e: any) => e.userId === 'bob')).toBe(true);
    });

    it('never leaks another user\'s entry — the critical security invariant', () => {
      const message: any = {
        attachmentKeys: [makeEntry('att-1', 'alice'), makeEntry('att-1', 'bob')],
      };
      filterAttachmentKeysForUser(message, 'alice');
      expect(message.attachmentKeys.some((e: any) => e.userId === 'bob')).toBe(false);
    });

    it('recurses into a populated replyTo', () => {
      const message: any = {
        attachmentKeys: [makeEntry('att-1', 'alice')],
        replyTo: {
          attachmentKeys: [makeEntry('att-2', 'alice'), makeEntry('att-2', 'bob')],
        },
      };
      filterAttachmentKeysForUser(message, 'alice');
      expect(message.replyTo.attachmentKeys).toHaveLength(1);
      expect(message.replyTo.attachmentKeys[0].userId).toBe('alice');
    });

    it('is a no-op when attachmentKeys is absent (every pre-existing message)', () => {
      const message: any = { encryptedContent: 'x' };
      expect(() => filterAttachmentKeysForUser(message, 'alice')).not.toThrow();
      expect(message.attachmentKeys).toBeUndefined();
    });
  });

  describe('stripAttachmentKeys', () => {
    it('empties attachmentKeys entirely, for callers (super-admin) who should never see any entry', () => {
      const message: any = { attachmentKeys: [makeEntry('att-1', 'alice'), makeEntry('att-1', 'bob')] };
      stripAttachmentKeys(message);
      expect(message.attachmentKeys).toEqual([]);
    });

    it('recurses into a populated replyTo', () => {
      const message: any = {
        attachmentKeys: [makeEntry('att-1', 'alice')],
        replyTo: { attachmentKeys: [makeEntry('att-2', 'alice')] },
      };
      stripAttachmentKeys(message);
      expect(message.attachmentKeys).toEqual([]);
      expect(message.replyTo.attachmentKeys).toEqual([]);
    });
  });
});
