import mongoose, { Document, Schema } from 'mongoose';

export interface IChatGroup extends Document {
  name: string;
  description?: string;
  createdBy: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  mutedBy: mongoose.Types.ObjectId[];
  chatLocks: mongoose.Types.ObjectId[];
  favouritedBy: mongoose.Types.ObjectId[];
  pinnedBy: mongoose.Types.ObjectId[];
  archivedBy: mongoose.Types.ObjectId[];
  markedUnreadBy: mongoose.Types.ObjectId[];
  projectId?: mongoose.Types.ObjectId;
  encryptionPublicKey: string;
  isActive: boolean;
  isPersonalChat: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const chatGroupSchema = new Schema<IChatGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    mutedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    chatLocks: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    favouritedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    pinnedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    archivedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    markedUnreadBy: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    encryptionPublicKey: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    isPersonalChat: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

chatGroupSchema.index({ members: 1, isActive: 1 });
chatGroupSchema.index({ createdBy: 1, createdAt: -1 });

export const ChatGroup = mongoose.model<IChatGroup>('ChatGroup', chatGroupSchema);
