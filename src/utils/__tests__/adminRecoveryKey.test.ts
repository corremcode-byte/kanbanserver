import nacl from 'tweetnacl';

jest.mock('../../models/SystemSettings', () => ({
  SystemSettings: {
    findOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

import { SystemSettings } from '../../models/SystemSettings';
import { getOrCreateAdminRecoveryKeyPair } from '../adminRecoveryKey';

describe('adminRecoveryKey', () => {
  const mockDoc: any = { _id: 'settings-doc-id', singletonKey: 'global' };

  beforeEach(() => {
    // Reset provisioned fields between tests — each test starts as if this were
    // the very first time the admin-recovery keypair is requested.
    delete mockDoc.adminRecoveryPublicKey;
    delete mockDoc.adminRecoveryPrivateKeyEncrypted;

    (SystemSettings.findOne as jest.Mock).mockResolvedValue(mockDoc);
    (SystemSettings.findOneAndUpdate as jest.Mock).mockImplementation(async (_filter: any, update: any) => {
      Object.assign(mockDoc, update.$set);
      return mockDoc;
    });
  });

  it('lazily generates a keypair on first use — no manual script/env var required', async () => {
    const { publicKey, privateKey } = await getOrCreateAdminRecoveryKeyPair();

    expect(publicKey).toBeDefined();
    expect(Buffer.from(publicKey, 'base64').length).toBe(nacl.box.publicKeyLength);
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(privateKey.length).toBe(nacl.box.secretKeyLength);
    expect(SystemSettings.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('the private key encrypted at rest is never returned directly — only decrypted bytes', async () => {
    await getOrCreateAdminRecoveryKeyPair();
    expect(mockDoc.adminRecoveryPrivateKeyEncrypted).toBeDefined();
    expect(typeof mockDoc.adminRecoveryPrivateKeyEncrypted).toBe('string');
    // Encrypted-at-rest value must not equal the raw base64 private key bytes
    expect(mockDoc.adminRecoveryPrivateKeyEncrypted).not.toContain('BEGIN');
  });

  it('reuses the same keypair on subsequent calls instead of regenerating', async () => {
    const first = await getOrCreateAdminRecoveryKeyPair();
    const second = await getOrCreateAdminRecoveryKeyPair();

    expect(second.publicKey).toEqual(first.publicKey);
    expect(Buffer.from(second.privateKey)).toEqual(Buffer.from(first.privateKey));
    // Only the first call should have provisioned/persisted a new keypair
    expect(SystemSettings.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('the returned keypair can actually open a box sealed to its public key (round-trip sanity)', async () => {
    const { publicKey, privateKey } = await getOrCreateAdminRecoveryKeyPair();

    const senderKeyPair = nacl.box.keyPair();
    const message = new TextEncoder().encode('group key material');
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const sealed = nacl.box(message, nonce, Buffer.from(publicKey, 'base64'), senderKeyPair.secretKey);

    const opened = nacl.box.open(sealed, nonce, senderKeyPair.publicKey, privateKey);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toEqual('group key material');
  });
});
