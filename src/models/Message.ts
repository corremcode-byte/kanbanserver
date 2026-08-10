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
    fileName: string;
    fileUrl: string;
    fileType: string;
    fileSize: number;
    duration?: number;
    mimeType?: string;
    // Compressed WebP copy for fast in-chat display, when the attachment is an
    // image. fileUrl always stays the untouched original (used for Open/Download).
    thumbnailUrl?: string;
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
      fileName: String,
      fileUrl: String,
      fileType: String,
      fileSize: Number,
      duration: Number,
      mimeType: String,
      thumbnailUrl: String
    }],
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
