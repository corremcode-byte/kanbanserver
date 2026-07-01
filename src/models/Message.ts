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
  attachments?: {
    fileName: string;
    fileUrl: string;
    fileType: string;
    fileSize: number;
    duration?: number;
    mimeType?: string;
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
      required: true
    },
    nonce: {
      type: String,
      required: true
    },
    attachments: [{
      fileName: String,
      fileUrl: String,
      fileType: String,
      fileSize: Number,
      duration: Number,
      mimeType: String
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
