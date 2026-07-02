import mongoose, { Document, Schema } from 'mongoose';

// Singleton document holding small, global (non-per-user) app configuration.
export interface IAppSettings extends Document {
  singletonKey: string;
  searchAccessCode: string;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const appSettingsSchema = new Schema<IAppSettings>(
  {
    singletonKey: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    // Secret code typed into the public wallpaper page's search bar to reach sign-in.
    // Default matches the value this replaces, so behavior is unchanged until an admin updates it.
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

export const AppSettings = mongoose.model<IAppSettings>('AppSettings', appSettingsSchema);
