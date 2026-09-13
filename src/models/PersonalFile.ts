import mongoose, { Schema, Document, Model } from 'mongoose';
import { PERSONAL_FILES_MAX_NAME_LENGTH } from '../config/personalFiles';

/**
 * PersonalFile — one collection modelling BOTH folders and files of each user's
 * private personal drive.
 *
 * Design notes:
 * - `type` discriminates a folder from a file; file-only fields are absent on folders.
 * - `parentId === null` is the user's root. There is no root document.
 * - `path` is the materialised ancestor chain (root-most first, immediate parent
 *   last). It makes whole-subtree operations a single query
 *   (`{ userId, path: folderId }`) instead of a recursive walk — used by recursive
 *   soft delete/restore and by move (re-parenting a subtree).
 * - `name` and `storagePath` are encrypted at rest with the project's existing
 *   field-encryption utility, keyed by this document's OWN `_id` (the established
 *   pattern — see utils/fieldEncryption.ts). Because the key is per-document and
 *   the nonce is random, encrypted names are NOT queryable: sibling duplicate
 *   checks and search decrypt in Node (see personalFilesController).
 * - `storagePath` is always a RELATIVE path (e.g. "personal-files/<uuid>.pdf"),
 *   never an absolute filesystem path and never a public URL.
 * - `isDeleted` drives the recycle bin; nothing is destroyed until the user
 *   permanently deletes it.
 */

export interface IPersonalFile extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'folder' | 'file';
  name: string;
  parentId: mongoose.Types.ObjectId | null;
  /** Ancestor ids, root-most first, immediate parent last. Empty at root. */
  path: mongoose.Types.ObjectId[];

  // file-only
  storagePath?: string;
  mimeType?: string;
  size?: number;
  originalName?: string;

  isDeleted: boolean;
  deletedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const PersonalFileSchema = new Schema<IPersonalFile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ['folder', 'file'],
      required: true
    },
    name: {
      type: String,
      required: true,
      // Business limit is PERSONAL_FILES_MAX_NAME_LENGTH plaintext chars, enforced in
      // personalFilesController before encryption. Raised here to comfortably fit the
      // ciphertext (name is encrypted at rest — see utils/fieldEncryption.ts), which
      // is longer than the original plaintext.
      maxlength: PERSONAL_FILES_MAX_NAME_LENGTH * 8 + 256
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'PersonalFile',
      default: null
    },
    path: {
      type: [{ type: Schema.Types.ObjectId, ref: 'PersonalFile' }],
      default: []
    },

    // ── file-only fields ────────────────────────────────────────────────────
    storagePath: {
      type: String,
      // Encrypted at rest; a relative path like "personal-files/<uuid>.ext".
      maxlength: 4096
    },
    mimeType: {
      type: String,
      maxlength: 255
    },
    size: {
      type: Number,
      min: 0
    },
    originalName: {
      type: String,
      maxlength: PERSONAL_FILES_MAX_NAME_LENGTH * 8 + 256
    },

    isDeleted: {
      type: Boolean,
      default: false
    },
    deletedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

// Folder listing: children of a folder for one user (the hot path).
PersonalFileSchema.index({ userId: 1, parentId: 1 });
// Folder-tree fetch for the Move dialog, and file-only aggregations.
PersonalFileSchema.index({ userId: 1, type: 1 });
// Recycle-bin listing and "exclude deleted" filters.
PersonalFileSchema.index({ userId: 1, isDeleted: 1 });
// Subtree operations (recursive delete/restore/move) resolve a whole subtree via
// the materialised ancestor array — this index is what makes that a single
// indexed query rather than a collection scan.
PersonalFileSchema.index({ userId: 1, path: 1 });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface IPersonalFileModel extends Model<IPersonalFile> {}

const PersonalFile = mongoose.model<IPersonalFile, IPersonalFileModel>(
  'PersonalFile',
  PersonalFileSchema
);

export default PersonalFile;
