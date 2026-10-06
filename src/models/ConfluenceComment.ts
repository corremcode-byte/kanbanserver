import mongoose, { Schema, Document, Model } from 'mongoose';
import { CONFLUENCE_MAX_COMMENT_LENGTH } from '../config/confluence';

/**
 * A comment on a published ConfluencePage. Kept in its own collection (rather than
 * embedded in the page) so busy discussions never bloat the page document that
 * every list/tree/search request loads.
 *
 * `content` is plain text, encrypted at rest keyed by the comment's OWN `_id`.
 * Deletion is soft so a removed comment never silently rewrites history.
 */
export interface IConfluenceComment extends Document {
  pageId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  content: string;
  /** Users @mentioned in this comment (validated against the text and page access). */
  mentions: mongoose.Types.ObjectId[];
  editedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ConfluenceCommentSchema = new Schema<IConfluenceComment>(
  {
    pageId: { type: Schema.Types.ObjectId, ref: 'ConfluencePage', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: {
      type: String,
      required: true,
      maxlength: CONFLUENCE_MAX_COMMENT_LENGTH * 8 + 256
    },
    mentions: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    editedAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

ConfluenceCommentSchema.index({ pageId: 1, isDeleted: 1, createdAt: 1 });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface IConfluenceCommentModel extends Model<IConfluenceComment> {}

const ConfluenceComment = mongoose.model<IConfluenceComment, IConfluenceCommentModel>(
  'ConfluenceComment',
  ConfluenceCommentSchema
);

export default ConfluenceComment;
