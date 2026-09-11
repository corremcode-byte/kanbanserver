import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISharedWith {
  userId: mongoose.Types.ObjectId;
  permission: 'view' | 'edit';
  sharedAt: Date;
}

// Same shape/semantics as kanbanserver/src/models/Task.ts's ITaskAttachment —
// see that file's comments for the encryptionVersion 0 vs 1 field meanings.
export interface INoteAttachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date;
  attachmentId?: string;
  isEncrypted?: boolean;
  encryptionVersion?: number;
  encryptionAlgorithm?: string;
  containerVersion?: number;
  chunkSize?: number;
  originalMimeType?: string;
  originalFileSize?: number;
  passwordProtected?: boolean;
  passwordSalt?: string;
  passwordKdfAlgorithm?: string;
  passwordKdfParams?: {
    iterations: number;
    parallelism: number;
    memorySize: number;
    hashLength: number;
  };
  encryptedFileKeyByPassword?: string;
  passwordFileKeyIv?: string;
}

export interface INote extends Document {
  title: string;
  description: string; // Kept for backward compatibility
  content?: string; // HTML content (primary field going forward)
  contentType: 'plain' | 'html'; // Content format type
  userId: mongoose.Types.ObjectId;
  sharedWith?: ISharedWith[]; // Users with access to this note
  attachments?: INoteAttachment[];
  // Sealed per-recipient copies of every encrypted attachment's random AES
  // file key. Recipients = this note's owner + sharedWith[].userId at upload
  // time — see controllers/uploadController.ts and docs/E2EE_ATTACHMENTS.md.
  // NO admin-recovery-sealed counterpart exists here, by design.
  attachmentKeys?: {
    attachmentId: string;
    userId: mongoose.Types.ObjectId;
    encryptedKey: string;
    nonce: string;
    senderPublicKey: string;
  }[];
  reminderDate?: Date;
  reminderFrequency?: 'none' | '30minutes' | '1hour' | '3hours' | '12hours' | '24hours' | '48hours' | 'custom';
  customReminderMinutes?: number;
  lastReminderSent?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NoteSchema = new Schema<INote>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      // Business limit is 200 plaintext chars, enforced in notesController before
      // encryption. Raised here to comfortably fit encrypted ciphertext (title/content
      // are encrypted at rest — see utils/fieldEncryption.ts), which is longer than
      // the original plaintext.
      maxlength: 2000
    },
    description: {
      type: String,
      required: false, // No longer required (backward compatibility)
      trim: true,
      maxlength: 10000
    },
    content: {
      type: String,
      required: false, // Either content or description must be present
      // Business limit is 50,000 plaintext chars, enforced via validateHtmlSize()
      // in notesController before encryption. Raised here to fit ciphertext.
      maxlength: 300000
    },
    contentType: {
      type: String,
      enum: ['plain', 'html'],
      default: 'plain'
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    sharedWith: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      permission: {
        type: String,
        enum: ['view', 'edit'],
        default: 'view'
      },
      sharedAt: {
        type: Date,
        default: Date.now
      }
    }],
    attachments: [{
      id: { type: String, required: true },
      name: { type: String, required: true },
      url: { type: String, required: true },
      type: { type: String, required: true },
      size: { type: Number, required: true },
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      uploadedAt: { type: Date, default: Date.now },
      attachmentId: String,
      isEncrypted: Boolean,
      encryptionVersion: { type: Number, default: 0 },
      encryptionAlgorithm: String,
      containerVersion: Number,
      chunkSize: Number,
      originalMimeType: String,
      originalFileSize: Number,
      passwordProtected: Boolean,
      passwordSalt: String,
      passwordKdfAlgorithm: String,
      passwordKdfParams: {
        iterations: Number,
        parallelism: Number,
        memorySize: Number,
        hashLength: Number
      },
      encryptedFileKeyByPassword: String,
      passwordFileKeyIv: String
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
    reminderDate: {
      type: Date
    },
    reminderFrequency: {
      type: String,
      enum: ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'],
      default: 'none'
    },
    customReminderMinutes: {
      type: Number,
      min: 1
    },
    lastReminderSent: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

// Index for efficient queries
NoteSchema.index({ userId: 1, createdAt: -1 });

interface INoteModel extends Model<INote> {
  findByUser(userId: string): Promise<INote[]>;
}

NoteSchema.statics.findByUser = function(userId: string) {
  return this.find({ userId }).sort({ updatedAt: -1 });
};

const Note = mongoose.model<INote, INoteModel>('Note', NoteSchema);

export default Note;
