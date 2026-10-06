import mongoose, { Schema, Document, Model } from 'mongoose';
import { CONFLUENCE_MAX_TITLE_LENGTH, CONFLUENCE_MAX_CONTENT_LENGTH } from '../config/confluence';

/**
 * ConfluencePage — one knowledge/documentation page (or a reusable template).
 *
 * Not a file: a page is structured rich-text content living entirely in MongoDB.
 * It is unrelated to PersonalFile/SharedFile and never stored on disk.
 *
 * Draft / published model
 * -----------------------
 * - `title` / `content` hold the PUBLISHED version. They are empty until the page
 *   is published for the first time.
 * - `draftTitle` / `draftContent` hold the working copy, with `hasDraft` true while
 *   one exists. A never-published page (`status: 'draft'`) only has a draft. A
 *   published page that is being edited keeps serving its published version to
 *   readers while the editor's unpublished changes sit in the draft fields.
 * - Publishing copies the draft into `title`/`content`, clears the draft and sets
 *   `status: 'published'` + `publishedAt`.
 * - Draft fields are only ever sent to users allowed to see drafts (the owner, and
 *   holders of the `edit` or `publish` permission) — see confluenceController.
 *
 * Version history: `currentVersion` numbers the published version. Publishing a
 * newer one first copies the outgoing version into ConfluencePageVersion, so the
 * live version is never duplicated and older ones are never lost.
 *
 * Templates (`isTemplate: true`) never use the draft fields: they are saved
 * straight into `title`/`content`, have no parent and never appear in the tree.
 *
 * Hierarchy: `parentId === null` is a root page. `path` is the materialised
 * ancestor chain (root-most first, immediate parent last), so a whole subtree is a
 * single `{ path: pageId }` query — the same approach SharedFile uses.
 *
 * Access: `restrictedTo` empty = every user holding confluence.view may read the
 * page (subject to draft rules). Non-empty = only those users plus the owner. A
 * restriction is inherited by every descendant.
 *
 * `title`, `content`, `draftTitle` and `draftContent` are encrypted at rest with
 * utils/fieldEncryption.ts, keyed by this document's OWN `_id`. Labels are plain
 * metadata so they can be filtered and listed.
 */

export type ConfluencePageStatus = 'draft' | 'published';

export interface IConfluencePage extends Document {
  title: string;
  content: string;
  draftTitle?: string;
  draftContent?: string;
  hasDraft: boolean;
  status: ConfluencePageStatus;

  parentId: mongoose.Types.ObjectId | null;
  path: mongoose.Types.ObjectId[];

  isTemplate: boolean;
  labels: string[];

  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  publishedAt?: Date;
  publishedBy?: mongoose.Types.ObjectId;
  /** Number of the current published version (1 = first publish). Absent on
   *  never-published pages, and on pages published before version history
   *  existed — those are treated as version 1 (see utils/confluenceVersions.ts). */
  currentVersion?: number;
  /** Set when the current version was produced by restoring an older one. */
  restoredFromVersion?: number;

  /** Review workflow (utils/confluenceReview.ts). 'in_review' = the draft has been
   *  submitted and is frozen until approved, sent back, or withdrawn. Absent =
   *  not in review. Kept separate from `status` (which only says whether a live
   *  version exists). Only ever sent to users who may see drafts. */
  reviewState?: 'in_review';
  reviewSubmittedBy?: mongoose.Types.ObjectId;
  reviewSubmittedAt?: Date;
  /** Outcome of the most recent review of the current draft cycle. */
  lastReviewOutcome?: 'changes_requested' | 'approved';
  lastReviewedBy?: mongoose.Types.ObjectId;
  lastReviewedAt?: Date;
  /** Reviewer's optional note when requesting changes — encrypted like the draft. */
  reviewNote?: string;

  favoritedBy: mongoose.Types.ObjectId[];
  restrictedTo: mongoose.Types.ObjectId[];

  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

// Ciphertext is longer than plaintext; the plaintext limits are enforced in the
// controller, these only stop a runaway document.
const ENCRYPTED_TITLE_MAX = CONFLUENCE_MAX_TITLE_LENGTH * 8 + 256;
const ENCRYPTED_CONTENT_MAX = CONFLUENCE_MAX_CONTENT_LENGTH * 2 + 1024;

const ConfluencePageSchema = new Schema<IConfluencePage>(
  {
    title: { type: String, default: '', maxlength: ENCRYPTED_TITLE_MAX },
    content: { type: String, default: '', maxlength: ENCRYPTED_CONTENT_MAX },
    draftTitle: { type: String, maxlength: ENCRYPTED_TITLE_MAX },
    draftContent: { type: String, maxlength: ENCRYPTED_CONTENT_MAX },
    hasDraft: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft'
    },

    parentId: { type: Schema.Types.ObjectId, ref: 'ConfluencePage', default: null },
    path: {
      type: [{ type: Schema.Types.ObjectId, ref: 'ConfluencePage' }],
      default: []
    },

    isTemplate: { type: Boolean, default: false },
    labels: { type: [String], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // No default on purpose: list queries use .lean(), which never applies
    // defaults, so the "absent" case must be handled in code either way.
    currentVersion: { type: Number, min: 1 },
    restoredFromVersion: { type: Number, min: 1 },

    reviewState: { type: String, enum: ['in_review'] },
    reviewSubmittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewSubmittedAt: { type: Date },
    lastReviewOutcome: { type: String, enum: ['changes_requested', 'approved'] },
    lastReviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastReviewedAt: { type: Date },
    reviewNote: { type: String, maxlength: 2000 * 8 + 256 },

    favoritedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    restrictedTo: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

// Live tree / list fetches.
ConfluencePageSchema.index({ isDeleted: 1, isTemplate: 1, parentId: 1 });
// Subtree operations (move, delete) via the materialised ancestor array.
ConfluencePageSchema.index({ path: 1 });
// "My Pages".
ConfluencePageSchema.index({ createdBy: 1, isDeleted: 1 });
// "Favorites".
ConfluencePageSchema.index({ favoritedBy: 1 });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface IConfluencePageModel extends Model<IConfluencePage> {}

const ConfluencePage = mongoose.model<IConfluencePage, IConfluencePageModel>('ConfluencePage', ConfluencePageSchema);

export default ConfluencePage;
