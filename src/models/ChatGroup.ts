import mongoose, { Document, Schema } from 'mongoose';

// One sealed copy of a group's random symmetric key, encrypted (nacl.box) to a
// single recipient's public key. `senderPublicKey` is the public key of whoever
// performed the sealing at that time — stored per-entry (not looked up live from
// User) so a later change to the sealer's own key pair can never break existing
// seals' box.open.
export interface ISealedKeyEntry {
  userId: mongoose.Types.ObjectId;
  encryptedKey: string; // base64 nacl.box ciphertext of the raw group key
  nonce: string; // base64
  senderPublicKey: string; // base64 — public key of whoever sealed this entry
}

export interface IKeyEpoch {
  version: number;
  createdAt: Date;
  createdBy: mongoose.Types.ObjectId;
  memberKeys: ISealedKeyEntry[];
  // Same group key, additionally sealed to the server-held admin-recovery
  // keypair (see utils/adminRecoveryKey.ts) so SuperAdminChatViewer keeps working.
  adminSealedKey?: {
    encryptedKey: string;
    nonce: string;
    senderPublicKey: string;
  };
}

export interface IChatGroup extends Document {
  name: string;
  description?: string;
  createdBy: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  mutedBy: mongoose.Types.ObjectId[];
  chatLocks: mongoose.Types.ObjectId[];
  favouritedBy: mongoose.Types.ObjectId[];
  pinnedBy: mongoose.Types.ObjectId[];
  archivedBy: mongoose.Types.ObjectId[];
  markedUnreadBy: mongoose.Types.ObjectId[];
  projectId?: mongoose.Types.ObjectId;
  encryptionPublicKey: string;
  // Chat message key-encryption scheme version. 1 (default) = legacy: the
  // symmetric key is derived deterministically from this group's own _id — no
  // real secret, kept only for backward-compatible decryption of pre-existing
  // groups/messages. >=2 = a real random key distributed via keyEpochs below.
  // NEVER touched on read/open — only bumped by an explicit rotation event
  // (group creation, member added/removed, or an explicit user-triggered upgrade).
  currentKeyVersion: number;
  keyEpochs: IKeyEpoch[];
  isActive: boolean;
  isPersonalChat: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const chatGroupSchema = new Schema<IChatGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    mutedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    chatLocks: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    favouritedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    pinnedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    archivedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    markedUnreadBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    encryptionPublicKey: { type: String, required: true },
    currentKeyVersion: { type: Number, default: 1 },
    keyEpochs: {
      type: [
        {
          version: { type: Number, required: true },
          createdAt: { type: Date, default: Date.now },
          createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          memberKeys: {
            type: [
              {
                userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
                encryptedKey: { type: String, required: true },
                nonce: { type: String, required: true },
                senderPublicKey: { type: String, required: true }
              }
            ],
            default: []
          },
          adminSealedKey: {
            type: {
              encryptedKey: { type: String, required: true },
              nonce: { type: String, required: true },
              senderPublicKey: { type: String, required: true }
            },
            required: false
          }
        }
      ],
      default: []
    },
    isActive: { type: Boolean, default: true },
    isPersonalChat: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

chatGroupSchema.index({ members: 1, isActive: 1 });
chatGroupSchema.index({ createdBy: 1, createdAt: -1 });

export const ChatGroup = mongoose.model<IChatGroup>('ChatGroup', chatGroupSchema);
