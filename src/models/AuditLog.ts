import mongoose, { Schema, Document, Model } from 'mongoose';
import { decryptProjectFields } from '../utils/fieldEncryption';

export interface IAuditLog extends Document {
  projectId?: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  action: 'task_created' | 'task_updated' | 'task_deleted' | 'task_assigned' |
          'task_status_changed' | 'task_completed' | 'member_added' | 'member_removed' |
          'permission_changed' | 'project_updated' | 'time_logged' | 'comment_added' |
          'comment_updated' | 'comment_deleted' | 'chat_group_created' | 'chat_group_deleted' |
          'user_login' | 'user_logout' | 'user_created' | 'user_password_updated' | 'user_passkey_set' |
          'user_passkey_changed' | 'user_password_reset' | 'user_sensitive_profile_updated' |
          'user_sensitive_profile_updated_by_admin' | 'user_passkey_updated_by_admin';
  entityType: 'task' | 'project' | 'member' | 'permission' | 'comment' | 'time_log' | 'chat_group' | 'user';
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
    ipAddress?: string;
    userAgent?: string;
    userName?: string;
    userEmail?: string;
    [key: string]: any;
  };
  createdAt: Date;
}

interface IAuditLogModel extends Model<IAuditLog> {
  logAction(data: {
    projectId?: string;
    userId: string;
    action: IAuditLog['action'];
    entityType: IAuditLog['entityType'];
    entityId?: string;
    metadata?: IAuditLog['metadata'];
  }): Promise<IAuditLog>;

  logSystemEvent(data: {
    userId: string;
    action: 'user_login' | 'user_logout' | 'user_created' | 'user_password_updated' | 'user_passkey_set' |
            'user_passkey_changed' | 'user_password_reset' | 'user_sensitive_profile_updated' |
            'user_sensitive_profile_updated_by_admin' | 'user_passkey_updated_by_admin' |
            'biometric_registered';
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

  cleanupDeletedUsers(): Promise<{ deletedCount: number }>;
}

const AuditLogSchema = new Schema<IAuditLog>({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: false,
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
      'comment_deleted',
      'chat_group_created',
      'chat_group_deleted',
      'user_login',
      'user_logout',
      'user_created',
      'user_password_updated',
      'user_passkey_set',
      'user_passkey_changed',
      'user_password_reset',
      'user_sensitive_profile_updated',
      'user_sensitive_profile_updated_by_admin',
      'user_passkey_updated_by_admin'
    ],
    required: true,
    index: true
  },
  entityType: {
    type: String,
    enum: ['task', 'project', 'member', 'permission', 'comment', 'time_log', 'chat_group', 'user'],
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
  projectId?: string;
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
  if (data.projectId) {
    await savedLog.populate('projectId', 'name');
    if (savedLog.projectId && typeof savedLog.projectId === 'object') {
      decryptProjectFields(savedLog.projectId as any);
    }
  }

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

// Static method to log system-level events (login, user creation, etc.)
AuditLogSchema.statics.logSystemEvent = async function(data: {
  userId: string;
  action: 'user_login' | 'user_logout' | 'user_created' | 'user_password_updated' | 'user_passkey_set' |
          'user_passkey_changed' | 'user_password_reset' | 'user_sensitive_profile_updated' |
          'user_sensitive_profile_updated_by_admin' | 'user_passkey_updated_by_admin';
  metadata?: IAuditLog['metadata'];
}): Promise<IAuditLog> {
  const log = new this({
    userId: data.userId,
    action: data.action,
    entityType: 'user',
    metadata: data.metadata || {}
  });

  const savedLog = await log.save();

  // Populate user info for real-time broadcast
  await savedLog.populate('userId', 'displayName email photoURL');

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
AuditLogSchema.statics.getProjectActivity = async function(
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

  // Find all logs first
  const logs = await this.find(query)
    .populate('userId', 'displayName email photoURL isActive')
    .sort({ createdAt: -1 })
    .limit(options.limit ? options.limit * 2 : 200); // Get more to filter out inactive users

  // Filter out logs for deleted or inactive users
  const User = mongoose.model('User');
  const activeLogs: IAuditLog[] = [];
  
  for (const log of logs) {
    if (log.userId) {
      const userId = typeof log.userId === 'object' && (log.userId as any)._id 
        ? (log.userId as any)._id.toString() 
        : log.userId.toString();
      
      // Check if user exists and is active
      const user = await User.findById(userId).select('isActive').lean() as { isActive?: boolean } | null;
      if (user && user.isActive !== false) {
        activeLogs.push(log);
        if (options.limit && activeLogs.length >= options.limit) {
          break;
        }
      }
    }
  }

  return activeLogs;
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

// Static method to cleanup audit logs for deleted or inactive users
AuditLogSchema.statics.cleanupDeletedUsers = async function(): Promise<{ deletedCount: number }> {
  const User = mongoose.model('User');
  
  // Get all unique user IDs from audit logs
  const distinctUserIds = await this.distinct('userId');
  
  let deletedCount = 0;
  
  // Check each user and delete logs for non-existent or inactive users
  for (const userId of distinctUserIds) {
    const user = await User.findById(userId).select('isActive').lean() as { isActive?: boolean } | null;
    
    // If user doesn't exist or is inactive, delete their audit logs
    if (!user || user.isActive === false) {
      const result = await this.deleteMany({ userId });
      deletedCount += result.deletedCount || 0;
    }
  }
  
  return { deletedCount };
};

export const AuditLog = mongoose.model<IAuditLog, IAuditLogModel>(
  'AuditLog',
  AuditLogSchema
);

export default AuditLog;
