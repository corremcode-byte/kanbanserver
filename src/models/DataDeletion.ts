import mongoose, { Document, Schema } from 'mongoose';

// Singleton document holding the Super-Admin-only "Delete All Data" password.
// Deliberately separate from User.password — this credential gates a single
// destructive operation and must survive that operation (it lives alongside
// SystemSettings as preserved application configuration, not user data).
export interface IDataDeletionConfig extends Document {
  singletonKey: string;
  passwordHash: string;
  setBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const dataDeletionConfigSchema = new Schema<IDataDeletionConfig>(
  {
    singletonKey: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    setBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

export const DataDeletionConfig = mongoose.model<IDataDeletionConfig>(
  'DataDeletionConfig',
  dataDeletionConfigSchema
);
