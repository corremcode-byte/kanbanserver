import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAuditLog extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  action: 'task_created' | 'task_updated' | 'task_deleted' | 'task_assigned' |
          'task_status_changed' | 'task_completed' | 'member_added' | 'member_removed' |
          'permission_changed' | 'project_updated' | 'time_logged' | 'comment_added' |
          'comment_updated' | 'comment_deleted';
  entityType: 'task' | 'project' | 'member' | 'permission' | 'comment' | 'time_log';
  entityId?: mongoose.Types.ObjectId;
  metadata?: {
    taskId?: string;
    taskTitle?: string;
    oldStatus?: string;
    newStatus?: string;
    oldValue?: string;
    newValue?: string;
    assigneeId?: string;
    assigneeName?: string;
    duration?: number; // For time logs (in minutes)
    [key: string]: any;
  };
  createdAt: Date;
}

interface IAuditLogModel extends Model<IAuditLog> {
  logAction(data: {
    projectId: string;
    userId: string;
    action: IAuditLog['action'];
    entityType: IAuditLog['entityType'];
    entityId?: string;
    metadata?: IAuditLog['metadata'];
  }): Promise<IAuditLog>;

  getProjectActivity(
    projectId: string,
    options?: {
      userId?: string;
      action?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<IAuditLog[]>;

  getUserStats(projectId: string, userId: string, startDate: Date, endDate: Date): Promise<{
    tasksCompleted: number;
    tasksCreated: number;
    tasksUpdated: number;
    totalTimeLogged: number; // in minutes
    actionsCount: number;
  }>;
}

const AuditLogSchema = new Schema<IAuditLog>({
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
  action: {
    type: String,
    enum: [
      'task_created',
      'task_updated',
      'task_deleted',
      'task_assigned',
      'task_status_changed',
      'task_completed',
      'member_added',
      'member_removed',
      'permission_changed',
      'project_updated',
      'time_logged',
      'comment_added',
      'comment_updated',
      'comment_deleted'
    ],
    required: true,
    index: true
  },
  entityType: {
    type: String,
    enum: ['task', 'project', 'member', 'permission', 'comment', 'time_log'],
    required: true
  },
  entityId: {
    type: Schema.Types.ObjectId,
    index: true
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }, // Only track creation time
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for efficient querying
AuditLogSchema.index({ projectId: 1, createdAt: -1 });
AuditLogSchema.index({ projectId: 1, userId: 1, createdAt: -1 });
AuditLogSchema.index({ projectId: 1, action: 1, createdAt: -1 });

// Static method to log an action
AuditLogSchema.statics.logAction = async function(data: {
  projectId: string;
  userId: string;
  action: IAuditLog['action'];
  entityType: IAuditLog['entityType'];
  entityId?: string;
  metadata?: IAuditLog['metadata'];
}): Promise<IAuditLog> {
  const log = new this({
    projectId: data.projectId,
    userId: data.userId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId,
    metadata: data.metadata || {}
  });

  const savedLog = await log.save();

  // Populate user and project info for real-time broadcast
  await savedLog.populate('userId', 'displayName email photoURL');
  await savedLog.populate('projectId', 'name');

  // Emit Socket.IO event for real-time updates
  try {
    const { getIO } = require('../socket');
    const io = getIO();

    // Broadcast to all connected clients
    io.emit('audit:new', {
      log: savedLog,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Failed to emit audit log event:', error);
  }

  return savedLog;
};

// Static method to get project activity
AuditLogSchema.statics.getProjectActivity = function(
  projectId: string,
  options: {
    userId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  } = {}
): Promise<IAuditLog[]> {
  const query: any = { projectId };

  if (options.userId) {
    query.userId = options.userId;
  }

  if (options.action) {
    query.action = options.action;
  }

  if (options.startDate || options.endDate) {
    query.createdAt = {};
    if (options.startDate) {
      query.createdAt.$gte = options.startDate;
    }
    if (options.endDate) {
      query.createdAt.$lte = options.endDate;
    }
  }

  return this.find(query)
    .populate('userId', 'displayName email photoURL')
    .sort({ createdAt: -1 })
    .limit(options.limit || 100);
};

// Static method to get user statistics
AuditLogSchema.statics.getUserStats = async function(
  projectId: string,
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<{
  tasksCompleted: number;
  tasksCreated: number;
  tasksUpdated: number;
  totalTimeLogged: number;
  actionsCount: number;
}> {
  const logs = await this.find({
    projectId,
    userId,
    createdAt: { $gte: startDate, $lte: endDate }
  });

  let tasksCompleted = 0;
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let totalTimeLogged = 0;

  logs.forEach((log: IAuditLog) => {
    switch (log.action) {
      case 'task_completed':
        tasksCompleted++;
        break;
      case 'task_created':
        tasksCreated++;
        break;
      case 'task_updated':
        tasksUpdated++;
        break;
      case 'time_logged':
        totalTimeLogged += log.metadata?.duration || 0;
        break;
    }
  });

  return {
    tasksCompleted,
    tasksCreated,
    tasksUpdated,
    totalTimeLogged,
    actionsCount: logs.length
  };
};

export const AuditLog = mongoose.model<IAuditLog, IAuditLogModel>(
  'AuditLog',
  AuditLogSchema
);

export default AuditLog;
