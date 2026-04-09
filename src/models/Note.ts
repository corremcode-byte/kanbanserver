import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISharedWith {
  userId: mongoose.Types.ObjectId;
  permission: 'view' | 'edit';
  sharedAt: Date;
}

export interface INote extends Document {
  title: string;
  description: string; // Kept for backward compatibility
  content?: string; // HTML content (primary field going forward)
  contentType: 'plain' | 'html'; // Content format type
  userId: mongoose.Types.ObjectId;
  sharedWith?: ISharedWith[]; // Users with access to this note
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
      maxlength: 200
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
      maxlength: 50000 // HTML is more verbose
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
