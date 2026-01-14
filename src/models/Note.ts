import mongoose, { Schema, Document, Model } from 'mongoose';

export interface INote extends Document {
  title: string;
  description: string;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const NoteSchema = new Schema<INote>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10000
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
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
