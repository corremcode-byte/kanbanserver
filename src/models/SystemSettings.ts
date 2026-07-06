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
      // Encrypted at rest (see utils/fieldEncryption.ts) — the 3-32 alphanumeric
      // business rule is enforced on the plaintext in systemSettingsController
      // before encryption, so it can't be validated here against the ciphertext.
      // The plaintext default below is handled by fieldEncryption's backward-
      // compatible passthrough (only decrypts values that look like ciphertext).
      type: String,
      required: true,
      trim: true,
      default: '1008',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

export const SystemSettings = mongoose.model<ISystemSettings>('SystemSettings', systemSettingsSchema);
