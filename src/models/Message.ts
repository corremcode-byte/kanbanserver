import mongoose, { Document, Schema } from 'mongoose';

export interface IReaction {
  userId: mongoose.Types.ObjectId;
  emoji: string;
  createdAt: Date;
}

export interface IMessage extends Document {
  groupId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  encryptedContent: string; // Encrypted message content
  nonce: string; // Encryption nonce for TweetNaCl
  // System messages (e.g. "X left the group") are generated server-side, not
  // E2E-encrypted client content — they carry plain text instead and skip the
  // encryptedContent/nonce requirement entirely.
  isSystemMessage: boolean;
  systemMessageText?: string;
  // Which of the owning ChatGroup's keyEpochs this message's encryptedContent/nonce
  // was encrypted under. Default 1 = legacy deterministic key (unchanged behavior
  // for every message that predates this field). Never rewritten after send/edit.
  keyVersion: number;
  attachments?: {
    // Client-generated uuid, stable identity for this attachment. Absent on
    // every pre-existing (encryptionVersion 0) row — never backfilled.
    attachmentId?: string;
    fileName: string;
    // For encryptionVersion 0: URL to the plaintext file. For 1: URL to the
    // opaque encrypted container — the server never parses either.
    fileUrl: string;
    // For encryptionVersion 0: the real MIME type. For 1: 'application/octet-stream'
    // (the wire type of the encrypted container) — the real type is originalMimeType.
    fileType: string;
    // For encryptionVersion 0: plaintext byte size. For 1: encrypted container size —
    // the real size is originalFileSize.
    fileSize: number;
    duration?: number;
    mimeType?: string;
    // Compressed WebP copy for fast in-chat display, when the attachment is an
    // unencrypted image. Never set for encryptionVersion 1 — the server cannot
    // thumbnail ciphertext. fileUrl always stays the untouched original (used
    // for Open/Download).
    thumbnailUrl?: string;
    // 0 (default, absent on legacy rows) = plaintext, stored/served as-is.
    // 1 = true E2EE: AES-256-GCM content, key never seen by the server (see
    // attachmentKeys below). Never bumped in place — a re-upload is a new attachment.
    isEncrypted?: boolean;
    encryptionVersion?: number;
    encryptionAlgorithm?: string; // e.g. 'AES-256-GCM', encryptionVersion 1 only
    containerVersion?: number; // encrypted-container framing format version
    chunkSize?: number; // plaintext bytes per chunk used at encryption time
    originalMimeType?: string; // real content type, encryptionVersion 1 only
    originalFileSize?: number; // real plaintext byte size, encryptionVersion 1 only
  }[];
  // Sealed copies of each encrypted attachment's random AES-256 file key, one
  // per (attachmentId, current-group-member) pair — nacl.box'd to that member's
  // encryptionPublicKey, same pattern as ChatGroup.keyEpochs[].memberKeys.
  // Deliberately has NO admin-recovery-sealed counterpart anywhere in this
  // array's shape: unlike text messages, attachment keys are never escrowed to
  // the server-held admin-recovery keypair (see utils/adminRecoveryKey.ts) —
  // that is what makes attachment content genuinely unreadable by a VPS/DB
  // administrator. Server-side, callers MUST filter this to the requesting
  // user's own entries before ever serializing a Message to a client — see
  // utils/attachmentKeyFiltering.ts.
  attachmentKeys?: {
    attachmentId: string;
    userId: mongoose.Types.ObjectId;
    encryptedKey: string; // base64 nacl.box ciphertext of the raw 32-byte AES key
    nonce: string; // base64
    senderPublicKey: string; // base64 — sealer's (sender's) public key at seal time
  }[];
  replyTo?: mongoose.Types.ObjectId;
  readBy: {
    userId: mongoose.Types.ObjectId;
    readAt: Date;
  }[];
  reactions: IReaction[];
  isPinned: boolean;
  pinnedBy?: mongoose.Types.ObjectId;
  starredBy: mongoose.Types.ObjectId[];
  isDeleted: boolean;
  isEdited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    groupId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatGroup',
      required: true,
      index: true
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    encryptedContent: {
      type: String,
      required: function (this: IMessage) { return !this.isSystemMessage; },
      default: ''
    },
    nonce: {
      type: String,
      required: function (this: IMessage) { return !this.isSystemMessage; },
      default: ''
    },
    isSystemMessage: {
      type: Boolean,
      default: false
    },
    systemMessageText: {
      type: String
    },
    keyVersion: {
      type: Number,
      default: 1
    },
    attachments: [{
      attachmentId: String,
      fileName: String,
      fileUrl: String,
      fileType: String,
      fileSize: Number,
      duration: Number,
      mimeType: String,
      thumbnailUrl: String,
      isEncrypted: Boolean,
      encryptionVersion: { type: Number, default: 0 },
      encryptionAlgorithm: String,
      containerVersion: Number,
      chunkSize: Number,
      originalMimeType: String,
      originalFileSize: Number
    }],
    attachmentKeys: {
      type: [{
        attachmentId: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        encryptedKey: { type: String, required: true },
        nonce: { type: String, required: true },
        senderPublicKey: { type: String, required: true }
      }],
      default: []
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: 'Message'
    },
    readBy: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      readAt: {
        type: Date,
        default: Date.now
      }
    }],
    reactions: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      emoji: {
        type: String,
        required: true
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    isPinned: {
      type: Boolean,
      default: false
    },
    pinnedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    starredBy: [{
      type: Schema.Types.ObjectId,
      ref: 'User'
    }],
    isDeleted: {
      type: Boolean,
      default: false
    },
    isEdited: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Indexes for performance
messageSchema.index({ groupId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, createdAt: -1 });
messageSchema.index({ groupId: 1, isDeleted: 1, createdAt: -1 });
messageSchema.index({ groupId: 1, isPinned: 1 });

export const Message = mongoose.model<IMessage>('Message', messageSchema);
