import nacl from 'tweetnacl';
import { SystemSettings } from '../models/SystemSettings';
import { encryptField, decryptField } from './fieldEncryption';

/**
 * Server-held NaCl box keypair that every chat group's random key (v2+) is also
 * sealed to, so SuperAdminChatViewer can keep decrypting chats after the move away
 * from the deterministic groupId-derived key. Lazily self-provisioned on first use
 * (no manual script/env var) and stored on the SystemSettings singleton, reusing
 * its existing get-or-create pattern (see systemSettingsController.ts). The private
 * key never leaves this function — callers get raw bytes in memory only.
 */

async function getOrCreateSettings() {
  let doc = await SystemSettings.findOne({ singletonKey: 'global' });
  if (!doc) {
    doc = await SystemSettings.create({ singletonKey: 'global' });
  }
  return doc;
}

export interface AdminRecoveryKeyPair {
  publicKey: string; // base64
  privateKey: Uint8Array;
}

export async function getOrCreateAdminRecoveryKeyPair(): Promise<AdminRecoveryKeyPair> {
  let doc = await getOrCreateSettings();

  if (!doc.adminRecoveryPublicKey || !doc.adminRecoveryPrivateKeyEncrypted) {
    const keyPair = nacl.box.keyPair();
    const publicKeyB64 = Buffer.from(keyPair.publicKey).toString('base64');
    const privateKeyB64 = Buffer.from(keyPair.secretKey).toString('base64');
    const encryptedPrivate = encryptField(privateKeyB64, doc._id.toString()) as string;

    // Atomic conditional update — if two requests race to provision this on first
    // use, only one wins; the other just re-fetches the winner's keypair below.
    const updated = await SystemSettings.findOneAndUpdate(
      { _id: doc._id, adminRecoveryPublicKey: { $exists: false } },
      { $set: { adminRecoveryPublicKey: publicKeyB64, adminRecoveryPrivateKeyEncrypted: encryptedPrivate } },
      { new: true }
    );
    doc = updated || (await SystemSettings.findOne({ singletonKey: 'global' }))!;
  }

  const privateKeyB64 = decryptField(doc.adminRecoveryPrivateKeyEncrypted!, doc._id.toString()) as string;
  return {
    publicKey: doc.adminRecoveryPublicKey!,
    privateKey: new Uint8Array(Buffer.from(privateKeyB64, 'base64'))
  };
}
