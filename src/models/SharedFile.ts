import mongoose, { Schema, Document, Model } from 'mongoose';
import { SHARED_FILES_MAX_NAME_LENGTH } from '../config/sharedFiles';

/**
 * SharedFile — one collection modelling BOTH folders and files of the ONE global
 * shared repository.
 *
 * This is a separate model from PersonalFile on purpose. The two differ in exactly
 * one fundamental way, and that difference is the whole reason they must never be
 * merged:
 *
 *   PersonalFile has `userId`  — the OWNER. Every query is scoped to it. A user can
 *                                 only ever see their own documents.
 *   SharedFile   has `uploadedBy` — the AUTHOR. It is metadata only ("Uploaded by
 *                                 Akhilesh"), never a visibility filter. Every user
 *                                 holding sharedFiles.view sees every document.
 *
 * There is no per-user copy of a shared file: User A uploads company-policy.pdf
 * once, and Users B and C see that same record.
 *
 * Other design notes (same as PersonalFile):
 * - `type` discriminates a folder from a file; file-only fields are absent on folders.
 * - `parentId === null` is the repository root. There is no root document.
 * - `path` is the materialised ancestor chain (root-most first, immediate parent
 *   last), so subtree operations are a single `{ path: folderId }` query.
 * - `name`, `storagePath` and `originalName` are encrypted at rest with the
 *   existing field-encryption utility, keyed by this document's OWN `_id`.
 *   Encrypted names are NOT queryable: duplicate checks and search decrypt in Node.
 * - `storagePath` is always a RELATIVE path ("shared-files/<uuid>.pdf"), never an
 *   absolute filesystem path and never a public URL.
 * - `isDeleted` drives the ONE GLOBAL recycle bin.
 */

export interface ISharedFile extends Document {
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

  /** Who created this record (upload, folder creation, or copy). Metadata only —
   *  it never restricts who can see or act on the item. */
  uploadedBy: mongoose.Types.ObjectId;

  isDeleted: boolean;
  deletedAt?: Date;
  /** Who moved it to the recycle bin (metadata for the bin listing). */
  deletedBy?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const SharedFileSchema = new Schema<ISharedFile>(
  {
    type: {
      type: String,
      enum: ['folder', 'file'],
      required: true
    },
    name: {
      type: String,
      required: true,
      // Business limit is SHARED_FILES_MAX_NAME_LENGTH plaintext chars, enforced in
      // sharedFilesController before encryption. Raised here to fit the ciphertext.
      maxlength: SHARED_FILES_MAX_NAME_LENGTH * 8 + 256
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'SharedFile',
      default: null
    },
    path: {
      type: [{ type: Schema.Types.ObjectId, ref: 'SharedFile' }],
      default: []
    },

    // ── file-only fields ────────────────────────────────────────────────────
    storagePath: {
      type: String,
      // Encrypted at rest; a relative path like "shared-files/<uuid>.ext".
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
      maxlength: SHARED_FILES_MAX_NAME_LENGTH * 8 + 256
    },

    // NOT an ownership field. See the model comment above.
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    isDeleted: {
      type: Boolean,
      default: false
    },
    deletedAt: {
      type: Date
    },
    deletedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true
  }
);

// Folder listing: live children of a folder (the hot path). Because the
// repository is global there is no userId prefix on any of these indexes.
SharedFileSchema.index({ parentId: 1, isDeleted: 1 });
// Folder-only queries within a parent (breadcrumb/destination validation).
SharedFileSchema.index({ parentId: 1, type: 1 });
// Folder-tree fetch for the Move dialog, and file-only usage aggregation.
SharedFileSchema.index({ type: 1, isDeleted: 1 });
// Global recycle-bin listing, newest deletion first.
SharedFileSchema.index({ isDeleted: 1, deletedAt: -1 });
// Subtree operations (recursive delete/restore/move/copy) resolve a whole subtree
// via the materialised ancestor array in one indexed query.
SharedFileSchema.index({ path: 1 });
// "Uploaded by" lookups and per-user attribution.
SharedFileSchema.index({ uploadedBy: 1 });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ISharedFileModel extends Model<ISharedFile> {}

const SharedFile = mongoose.model<ISharedFile, ISharedFileModel>('SharedFile', SharedFileSchema);

export default SharedFile;
