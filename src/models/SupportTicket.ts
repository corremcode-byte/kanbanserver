import mongoose, { Schema, Document } from 'mongoose';

export interface IAttachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface ISupportReply {
  _id?: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  message: string;
  attachments: IAttachment[];
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'question' | 'other';
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  raisedBy: mongoose.Types.ObjectId;
  raisedByName: string;
  raisedByEmail: string;
  attachments: IAttachment[];
  replies: ISupportReply[];
  createdAt: Date;
  updatedAt: Date;
}

const AttachmentSchema = new Schema<IAttachment>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  type: { type: String, required: true },
  size: { type: Number, required: true },
}, { _id: false });

const ReplySchema = new Schema<ISupportReply>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  // Business limit is 5,000 plaintext chars, enforced in supportController before
  // encryption. Raised here to comfortably fit encrypted ciphertext (message is
  // encrypted at rest — see utils/fieldEncryption.ts), which is longer than plaintext.
  message: { type: String, required: true, maxlength: 30000 },
  attachments: { type: [AttachmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    // Business limits (title 200 / description 5,000 plaintext chars) are enforced in
    // supportController before encryption. Raised here to comfortably fit ciphertext.
    title: { type: String, required: true, trim: true, maxlength: 2000 },
    description: { type: String, required: true, trim: true, maxlength: 30000 },
    category: {
      type: String,
      enum: ['bug', 'feature', 'question', 'other'],
      default: 'question',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    status: {
      type: String,
      enum: ['open', 'in-progress', 'resolved', 'closed'],
      default: 'open',
    },
    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    raisedByName: { type: String, required: true },
    raisedByEmail: { type: String, required: true },
    attachments: { type: [AttachmentSchema], default: [] },
    replies: { type: [ReplySchema], default: [] },
  },
  { timestamps: true }
);

SupportTicketSchema.index({ status: 1, createdAt: -1 });
SupportTicketSchema.index({ raisedBy: 1, createdAt: -1 });

export default mongoose.model<ISupportTicket>('SupportTicket', SupportTicketSchema);
