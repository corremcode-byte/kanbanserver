import mongoose, { Document, Schema } from 'mongoose';

// Singleton document holding small, global (non-per-user) system configuration.
export interface ISystemSettings extends Document {
  singletonKey: string;
  searchAccessCode: string;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingsSchema = new Schema<ISystemSettings>(
  {
    singletonKey: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    searchAccessCode: {
      type: String,
      required: true,
      trim: true,
      default: '1008',
      match: [/^[A-Za-z0-9]{3,32}$/, 'Search access code must be 3-32 letters/numbers only'],
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

export const SystemSettings = mongoose.model<ISystemSettings>('SystemSettings', systemSettingsSchema);
