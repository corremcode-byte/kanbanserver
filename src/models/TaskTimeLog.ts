import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ITaskTimeLog extends Document {
  taskId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  timeSpent: number; // in minutes
  description?: string;
  loggedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ITaskTimeLogModel extends Model<ITaskTimeLog> {
  findByTask(taskId: string): Promise<ITaskTimeLog[]>;
  findByUser(userId: string, startDate?: Date, endDate?: Date): Promise<ITaskTimeLog[]>;
  findByProject(projectId: string, startDate?: Date, endDate?: Date): Promise<ITaskTimeLog[]>;
  getTotalTimeByTask(taskId: string): Promise<number>;
  getTotalTimeByUser(userId: string, startDate?: Date, endDate?: Date): Promise<number>;
}

const TaskTimeLogSchema = new Schema<ITaskTimeLog>({
  taskId: {
    type: Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true
  },
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  timeSpent: {
    type: Number,
    required: true,
    min: 0
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  loggedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// Compound indexes for efficient queries
TaskTimeLogSchema.index({ taskId: 1, userId: 1, loggedAt: -1 });
TaskTimeLogSchema.index({ projectId: 1, userId: 1, loggedAt: -1 });
TaskTimeLogSchema.index({ userId: 1, loggedAt: -1 });

// Find time logs by task
TaskTimeLogSchema.statics.findByTask = function(taskId: string): Promise<ITaskTimeLog[]> {
  return this.find({ taskId })
    .populate('userId', 'displayName email photoURL')
    .sort({ loggedAt: -1 });
};

// Find time logs by user with optional date range
TaskTimeLogSchema.statics.findByUser = function(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<ITaskTimeLog[]> {
  const query: any = { userId };

  if (startDate || endDate) {
    query.loggedAt = {};
    if (startDate) query.loggedAt.$gte = startDate;
    if (endDate) query.loggedAt.$lte = endDate;
  }

  return this.find(query)
    .populate('taskId', 'title')
    .populate('projectId', 'name')
    .sort({ loggedAt: -1 });
};

// Find time logs by project with optional date range
TaskTimeLogSchema.statics.findByProject = function(
  projectId: string,
  startDate?: Date,
  endDate?: Date
): Promise<ITaskTimeLog[]> {
  const query: any = { projectId };

  if (startDate || endDate) {
    query.loggedAt = {};
    if (startDate) query.loggedAt.$gte = startDate;
    if (endDate) query.loggedAt.$lte = endDate;
  }

  return this.find(query)
    .populate('userId', 'displayName email')
    .populate('taskId', 'title')
    .sort({ loggedAt: -1 });
};

// Get total time spent on a task
TaskTimeLogSchema.statics.getTotalTimeByTask = async function(taskId: string): Promise<number> {
  const result = await this.aggregate([
    { $match: { taskId: new mongoose.Types.ObjectId(taskId) } },
    { $group: { _id: null, totalTime: { $sum: '$timeSpent' } } }
  ]);

  return result.length > 0 ? result[0].totalTime : 0;
};

// Get total time spent by user with optional date range
TaskTimeLogSchema.statics.getTotalTimeByUser = async function(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<number> {
  const match: any = { userId: new mongoose.Types.ObjectId(userId) };

  if (startDate || endDate) {
    match.loggedAt = {};
    if (startDate) match.loggedAt.$gte = startDate;
    if (endDate) match.loggedAt.$lte = endDate;
  }

  const result = await this.aggregate([
    { $match: match },
    { $group: { _id: null, totalTime: { $sum: '$timeSpent' } } }
  ]);

  return result.length > 0 ? result[0].totalTime : 0;
};

export const TaskTimeLog = mongoose.model<ITaskTimeLog, ITaskTimeLogModel>(
  'TaskTimeLog',
  TaskTimeLogSchema
);

export default TaskTimeLog;
