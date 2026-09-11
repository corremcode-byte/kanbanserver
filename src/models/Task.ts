import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ITaskAttachment {
  id: string;
  name: string;
  // For encryptionVersion 0 (legacy, default): direct URL to the plaintext
  // file. For 1: URL to the opaque AES-256-GCM encrypted container — see
  // kanbanclient/src/services/attachmentEncryptionService.ts. Either way this
  // string is additionally obfuscated at rest via fieldEncryption.ts (keyed by
  // the parent TASK's own id, even for subtask attachments) — unrelated to,
  // and unaffected by, true E2EE.
  url: string;
  // For encryptionVersion 0: the real MIME type. For 1: 'application/octet-stream'.
  type: string;
  // For encryptionVersion 0: plaintext byte size. For 1: encrypted container size.
  size: number;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date;
  // Stable client-generated uuid, present for encryptionVersion 1, absent on
  // every pre-existing (legacy plaintext) attachment. Referenced by this
  // task's own top-level attachmentKeys[] (see ITask.attachmentKeys below).
  attachmentId?: string;
  isEncrypted?: boolean;
  // 0 (default/absent) = plaintext. 1 = true E2EE — the server never sees the
  // plaintext file or the AES key; see docs/E2EE_ATTACHMENTS.md.
  encryptionVersion?: number;
  encryptionAlgorithm?: string;
  containerVersion?: number;
  chunkSize?: number;
  originalMimeType?: string;
  originalFileSize?: number;
  // Optional ADDITIONAL password protection layer, independent of this task's
  // top-level attachmentKeys[] nacl.box sealing — see
  // kanbanclient/src/services/attachmentEncryptionService.ts. Opaque to the
  // server; never derived/validated cryptographically here.
  passwordProtected?: boolean;
  passwordSalt?: string;
  passwordKdfAlgorithm?: string;
  passwordKdfParams?: {
    iterations: number;
    parallelism: number;
    memorySize: number;
    hashLength: number;
  };
  encryptedFileKeyByPassword?: string;
  passwordFileKeyIv?: string;
}

export interface ITaskComment {
  id: string;
  text: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt?: Date;
}

export interface ISubtask {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  status?: 'todo' | 'in-progress' | 'completed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assigneeId?: mongoose.Types.ObjectId;
  dueDate?: Date;
  reminderFrequency?: 'none' | '30minutes' | '1hour' | '3hours' | '12hours' | '24hours' | '48hours' | 'custom';
  customReminderMinutes?: number;
  linkedTaskId?: mongoose.Types.ObjectId;
  attachments?: ITaskAttachment[];
}

export interface ITask extends Document {
  title: string;
  description?: string;
  status: string; // legacy - kept for backward compatibility, now supports custom values
  listId: string; // new - references project column/list ID
  priority: 'low' | 'medium' | 'high' | 'critical';
  projectId?: mongoose.Types.ObjectId;
  assigneeId?: mongoose.Types.ObjectId; // legacy
  assignedTo?: mongoose.Types.ObjectId; // legacy - single assignee
  assignees: mongoose.Types.ObjectId[]; // new - multiple assignees
  assignedBy?: mongoose.Types.ObjectId;
  assignedAt?: Date; // Track when task was first assigned
  createdBy: mongoose.Types.ObjectId;
  dueDate: Date;
  isSubtask?: boolean;
  parentTaskId?: mongoose.Types.ObjectId;
  completedAt?: Date; // Track when task was marked as completed
  reminderFrequency?: 'none' | '30minutes' | '1hour' | '3hours' | '12hours' | '24hours' | '48hours' | 'custom';
  customReminderMinutes?: number;
  reminderStartTime?: string; // "HH:MM" e.g. "09:00"
  reminderEndTime?: string;   // "HH:MM" e.g. "18:00"
  lastReminderSent?: Date;
  attachments: ITaskAttachment[];
  // Sealed per-recipient copies of every encrypted attachment's random AES
  // file key — covers BOTH task-level (attachments above) and subtask-level
  // (subtasks[].attachments) attachments together in one flat array, keyed by
  // attachmentId (a client-generated uuid, globally unique regardless of
  // which array its metadata lives in). Recipients = this task's project's
  // current owner/owners/members/managers at upload time — see
  // controllers/uploadController.ts and docs/E2EE_ATTACHMENTS.md. NO
  // admin-recovery-sealed counterpart exists here, by design.
  attachmentKeys?: {
    attachmentId: string;
    userId: mongoose.Types.ObjectId;
    encryptedKey: string;
    nonce: string;
    senderPublicKey: string;
  }[];
  comments: ITaskComment[];
  subtasks: ISubtask[];
  order: number;
  createdAt: Date;
  updatedAt: Date;
  // Soft-delete fields
  likes: mongoose.Types.ObjectId[];
  isDeleted?: boolean;
  deletedAt?: Date;
  deletedBy?: mongoose.Types.ObjectId;
}

interface ITaskModel extends Model<ITask> {
  findByProject(projectId: string): Promise<ITask[]>;
  findByAssignee(userId: string): Promise<ITask[]>;
  reorderTasks(projectId: string, tasks: Array<{_id: string, status: string, order: number}>): Promise<void>;
}

const TaskSchema = new Schema<ITask>({
  title: { 
    type: String, 
    required: true,
    trim: true
  },
  description: { 
    type: String,
    trim: true
  },
  status: {
    type: String,
    default: 'todo'
    // No enum restriction to support custom list IDs
  },
  listId: {
    type: String,
    default: 'todo' // default to 'todo' list for backward compatibility
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  projectId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Project',
    required: false
  },
  assigneeId: { 
    type: Schema.Types.ObjectId, 
    ref: 'User' 
  },
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  assignees: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  assignedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  assignedAt: {
    type: Date,
    index: true
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dueDate: { 
    type: Date,
    required: true
  },
  isSubtask: {
    type: Boolean,
    default: false,
    index: true
  },
  parentTaskId: {
    type: Schema.Types.ObjectId,
    ref: 'Task',
    index: true
  },
  completedAt: {
    type: Date,
    index: true
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
  reminderStartTime: { type: String }, // "HH:MM" — only send reminders at/after this time
  reminderEndTime: { type: String },   // "HH:MM" — only send reminders before this time
  lastReminderSent: { type: Date },
  attachments: [{
    id: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
    attachmentId: String,
    isEncrypted: Boolean,
    encryptionVersion: { type: Number, default: 0 },
    encryptionAlgorithm: String,
    containerVersion: Number,
    chunkSize: Number,
    originalMimeType: String,
    originalFileSize: Number,
    passwordProtected: Boolean,
    passwordSalt: String,
    passwordKdfAlgorithm: String,
    passwordKdfParams: {
      iterations: Number,
      parallelism: Number,
      memorySize: Number,
      hashLength: Number
    },
    encryptedFileKeyByPassword: String,
    passwordFileKeyIv: String
  }],
  attachmentKeys: {
    type: [{
      attachmentId: { type: String, required: true },
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      encryptedKey: { type: String, required: true },
      nonce: { type: String, required: true },
      senderPublicKey: { type: String, required: true }
    }],
    default: []
  },
  comments: [{
    id: { type: String, required: true },
    text: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date }
  }],
  subtasks: [{
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    completed: { type: Boolean, default: false },
    status: { type: String, enum: ['todo', 'in-progress', 'completed'], default: 'todo' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User' },
    dueDate: { type: Date },
    reminderFrequency: { type: String, enum: ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'], default: 'none' },
    customReminderMinutes: { type: Number, min: 1 },
    linkedTaskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    attachments: [{
      id: { type: String, required: true },
      name: { type: String, required: true },
      url: { type: String, required: true },
      type: { type: String, required: true },
      size: { type: Number, required: true },
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      uploadedAt: { type: Date, default: Date.now },
      attachmentId: String,
      isEncrypted: Boolean,
      encryptionVersion: { type: Number, default: 0 },
      encryptionAlgorithm: String,
      containerVersion: Number,
      chunkSize: Number,
      originalMimeType: String,
      originalFileSize: Number,
      passwordProtected: Boolean,
      passwordSalt: String,
      passwordKdfAlgorithm: String,
      passwordKdfParams: {
        iterations: Number,
        parallelism: Number,
        memorySize: Number,
        hashLength: Number
      },
      encryptedFileKeyByPassword: String,
      passwordFileKeyIv: String
    }]
  }],
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  order: { type: Number, default: 0 },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

TaskSchema.index({ projectId: 1, status: 1, order: 1 });
TaskSchema.index({ projectId: 1, listId: 1, order: 1 });
TaskSchema.index({ assigneeId: 1 });

// Pre-save hook to sync listId with status for backward compatibility
TaskSchema.pre('save', function(next) {
  // If listId is set but status is not updated, sync status with listId
  if (this.isModified('listId') && !this.isModified('status')) {
    if (this.listId === 'todo') this.status = 'todo';
    else if (this.listId === 'in-progress') this.status = 'in-progress';
    else if (this.listId === 'completed') this.status = 'completed';
    else this.status = 'todo'; // default
  }
  // If status is set but listId is not updated, sync listId with status
  if (this.isModified('status') && !this.isModified('listId')) {
    this.listId = this.status;
  }
  next();
});

// Find tasks by project
TaskSchema.statics.findByProject = function(projectId: string): Promise<ITask[]> {
  return this.find({ projectId, isDeleted: { $ne: true } })
    .sort({ status: 1, order: 1 })
    .populate('assigneeId', 'name email avatar');
};

// Find tasks by assignee
TaskSchema.statics.findByAssignee = function(userId: string): Promise<ITask[]> {
  return this.find({
    isDeleted: { $ne: true },
    $or: [
      { assigneeId: userId },
      { assignedTo: userId },
      { assignees: userId }
    ]
  })
    .sort({ dueDate: 1, priority: -1 })
    .populate('projectId', 'name color');
};

// Reorder tasks
TaskSchema.statics.reorderTasks = async function(
  projectId: string,
  tasks: Array<{_id: string, status: string, listId?: string, order: number}>
): Promise<void> {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const task of tasks) {
      const updateData: any = {
        status: task.status,
        order: task.order
      };
      // If listId is provided, use it; otherwise use status
      if (task.listId) {
        updateData.listId = task.listId;
      } else {
        updateData.listId = task.status;
      }

      await this.findByIdAndUpdate(
        task._id,
        updateData,
        { session }
      );
    }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const Task = mongoose.model<ITask, ITaskModel>('Task', TaskSchema);
export default Task;