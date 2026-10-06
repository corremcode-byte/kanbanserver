import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * One row per (user, page): when that user last opened the page. Drives the
 * "Recent Pages" list. Upserted on every page view, so it never grows beyond
 * users x pages.
 */
export interface IConfluencePageView extends Document {
  userId: mongoose.Types.ObjectId;
  pageId: mongoose.Types.ObjectId;
  viewedAt: Date;
}

const ConfluencePageViewSchema = new Schema<IConfluencePageView>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  pageId: { type: Schema.Types.ObjectId, ref: 'ConfluencePage', required: true },
  viewedAt: { type: Date, default: Date.now }
});

ConfluencePageViewSchema.index({ userId: 1, pageId: 1 }, { unique: true });
ConfluencePageViewSchema.index({ userId: 1, viewedAt: -1 });

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface IConfluencePageViewModel extends Model<IConfluencePageView> {}

const ConfluencePageView = mongoose.model<IConfluencePageView, IConfluencePageViewModel>(
  'ConfluencePageView',
  ConfluencePageViewSchema
);

export default ConfluencePageView;
