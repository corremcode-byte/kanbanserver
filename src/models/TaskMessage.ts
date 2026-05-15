import mongoose, { Schema, Document } from 'mongoose';

export interface ITaskMessage extends Document {
  taskId: mongoose.Types.ObjectId;
  text: string;
  sentBy: mongoose.Types.ObjectId;
  mentions: mongoose.Types.ObjectId[];
  createdAt: Date;
}

const TaskMessageSchema = new Schema<ITaskMessage>(
  {
    taskId:   { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    text:     { type: String, required: true, trim: true },
    sentBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export default mongoose.model<ITaskMessage>('TaskMessage', TaskMessageSchema);
