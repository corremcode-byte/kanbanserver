import mongoose, { Schema, Document, Model } from 'mongoose';
import { CONFLUENCE_MAX_TITLE_LENGTH, CONFLUENCE_MAX_CONTENT_LENGTH } from '../config/confluence';

/**
 * ConfluencePageVersion — one SUPERSEDED published version of a ConfluencePage.
 *
 * The page document itself always holds the current published version
 * (ConfluencePage.title/content, numbered ConfluencePage.currentVersion). Only
 * when a newer version is published is the outgoing one copied here, so the live
 * version is never stored twice. History = these rows + the page's current version.
 *
 * Rows are immutable once written and are only ever reached through their page
 * (pageId + version number), after the page's own access checks — there is no
 * route that looks a version up by its own `_id`.
 *
 * `title` and `content` are encrypted at rest with utils/fieldEncryption.ts,
 * keyed by this document's OWN `_id`, like every other content document.
 */
export interface IConfluencePageVersion extends Document {
  pageId: mongoose.Types.ObjectId;
  version: number;
  title: string;
  content: string;
  /** Labels on the page when this version was superseded (labels are page
   *  metadata, not part of the publish flow, so this is a snapshot for display). */
  labels: string[];
  /** Who published this version. */
  createdBy: mongoose.Types.ObjectId;
  /** When this version was published (createdAt is when it was archived). */
  publishedAt: Date;
  /** Set when this version was produced by restoring an older one. */
  restoredFromVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const ConfluencePageVersionSchema = new Schema<IConfluencePageVersion>(
  {
    pageId: { type: Schema.Types.ObjectId, ref: 'ConfluencePage', required: true },
    version: { type: Number, required: true, min: 1 },
    title: { type: String, default: '', maxlength: CONFLUENCE_MAX_TITLE_LENGTH * 8 + 256 },
    content: { type: String, default: '', maxlength: CONFLUENCE_MAX_CONTENT_LENGTH * 2 + 1024 },
    labels: { type: [String], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date, required: true },
    restoredFromVersion: { type: Number, min: 1 }
  },
  { timestamps: true }
);

// One row per (page, version) — also the guard that stops two concurrent
// publishes from archiving the same outgoing version twice. Descending so the
// history list (newest first) is an index scan.
ConfluencePageVersionSchema.index({ pageId: 1, version: -1 }, { unique: true });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface IConfluencePageVersionModel extends Model<IConfluencePageVersion> {}

const ConfluencePageVersion = mongoose.model<IConfluencePageVersion, IConfluencePageVersionModel>(
  'ConfluencePageVersion',
  ConfluencePageVersionSchema
);

export default ConfluencePageVersion;
