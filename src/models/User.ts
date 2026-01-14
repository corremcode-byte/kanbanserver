import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface IUser extends Document {
  username: string;  // Unique, immutable username
  email: string;
  password: string;
  displayName: string;
  photoURL?: string;
  bio?: string;
  role: 'admin' | 'manager' | 'member';
  isActive: boolean;
  lastLoginAt: Date;
  pushSubscriptions?: IPushSubscription[];
  comparePassword(candidatePassword: string): Promise<boolean>;
  permissions?: {
    // Project permissions
    canCreateProjects?: boolean;
    canDeleteProjects?: boolean;
    canManageAllProjects?: boolean;
    canViewAllProjects?: boolean;
    canCreatePersonalProjects?: boolean;
    // Task permissions
    canCreateTasks?: boolean;
    canEditTasks?: boolean;
    canDeleteTasks?: boolean;
    canAssignTasks?: boolean;
    canMoveTasks?: boolean;
    // Chat permissions
    canCreateChatGroups?: boolean;
    canEditChatGroups?: boolean;
    canDeleteChatGroups?: boolean;
    canDeleteOwnChatGroups?: boolean;
    // System permissions
    canViewAnalytics?: boolean;
    canExportData?: boolean;
    canManageUsers?: boolean;
    // Profile editing permissions
    canEditDisplayName?: boolean;
    canEditEmail?: boolean;
    canEditPassword?: boolean;
    // Auto-logout permission
    autoLogout?: boolean;
    autoLogoutTimerMinutes?: number; // Timer in minutes
    // Module permissions (with sub-permissions)
    modules?: {
      dashboard?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      myTasks?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      projects?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      chat?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      profile?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      userManagement?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      performance?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
      auditLog?: { 
        view?: boolean; 
        edit?: boolean;
        [key: string]: boolean | undefined;
      };
    };
  };
  settings?: {
    appearance?: {
      theme?: 'light' | 'dark' | 'system';
      colorScheme?: string;
      fontSize?: 'small' | 'medium' | 'large';
    };
    notifications?: {
      emailNotifications?: boolean;
      taskDeadlineReminders?: boolean;
      dailyDigest?: boolean;
      pushNotifications?: boolean;
      taskAssignedEmail?: boolean;
      taskAssignedPush?: boolean;
      taskMovedEmail?: boolean;
      taskMovedPush?: boolean;
      taskCompletedEmail?: boolean;
      taskCompletedPush?: boolean;
    };
    boardPreferences?: {
      defaultView?: 'kanban' | 'list';
      autoArchiveCompleted?: boolean;
      taskSorting?: 'due_date' | 'priority' | 'alphabetical' | 'created_date';
    };
  };
  createdAt: Date;
  updatedAt: Date;
  toJSON(): Partial<IUser>;
}

interface IUserMethods {
  toJSON(): Partial<IUser>;
}

interface IUserModel extends Model<IUser, {}, IUserMethods> {
  searchUsers(query: string, limit?: number): Promise<IUser[]>;
}

const userSchema = new Schema<IUser, IUserModel, IUserMethods>({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
    immutable: true,  // Username cannot be changed after creation
    match: [/^[a-z0-9_-]{3,20}$/, 'Username must be 3-20 characters long and contain only lowercase letters, numbers, hyphens, and underscores']
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    required: true,
    select: false // Don't include password in queries by default
  },
  displayName: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  photoURL: {
    type: String,
    trim: true
  },
  bio: {
    type: String,
    trim: true,
    maxlength: 500
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'member'],
    default: 'member'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLoginAt: {
    type: Date,
    default: Date.now
  },
  pushSubscriptions: [{
    endpoint: {
      type: String,
      required: true
    },
    keys: {
      p256dh: {
        type: String,
        required: true
      },
      auth: {
        type: String,
        required: true
      }
    }
  }],
  permissions: {
    // Project permissions
    canCreateProjects: { type: Boolean, default: false },
    canDeleteProjects: { type: Boolean, default: false },
    canManageAllProjects: { type: Boolean, default: false },
    canViewAllProjects: { type: Boolean, default: false },
    // Task permissions
    canCreateTasks: { type: Boolean, default: false },
    canEditTasks: { type: Boolean, default: false },
    canDeleteTasks: { type: Boolean, default: false },
    canAssignTasks: { type: Boolean, default: false },
    canMoveTasks: { type: Boolean, default: false },
    // Chat permissions
    canCreateChatGroups: { type: Boolean, default: false },
    canEditChatGroups: { type: Boolean, default: false },
    canDeleteChatGroups: { type: Boolean, default: false },
    canDeleteOwnChatGroups: { type: Boolean, default: false },
    // System permissions
    canViewAnalytics: { type: Boolean, default: false },
    canExportData: { type: Boolean, default: false },
    canManageUsers: { type: Boolean, default: false },
    // Profile editing permissions
    canEditDisplayName: { type: Boolean, default: false },
    canEditEmail: { type: Boolean, default: false },
    canEditPassword: { type: Boolean, default: false },
    // Auto-logout permission
    autoLogout: { type: Boolean, default: false },
    autoLogoutTimerMinutes: { type: Number, default: null, min: 1 },
    // Module permissions (with sub-permissions)
    modules: {
      dashboard: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      myTasks: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      projects: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      chat: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      profile: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      userManagement: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      performance: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      },
      auditLog: { 
        type: Schema.Types.Mixed, 
        default: { view: false, edit: false } 
      }
    }
  },
  settings: {
    appearance: {
      theme: {
        type: String,
        enum: ['light', 'dark', 'system'],
        default: 'system'
      },
      colorScheme: {
        type: String,
        default: 'blue'
      },
      fontSize: {
        type: String,
        enum: ['small', 'medium', 'large'],
        default: 'medium'
      }
    },
    notifications: {
      emailNotifications: {
        type: Boolean,
        default: true
      },
      taskDeadlineReminders: {
        type: Boolean,
        default: true
      },
      dailyDigest: {
        type: Boolean,
        default: false
      },
      pushNotifications: {
        type: Boolean,
        default: true
      },
      taskAssignedEmail: {
        type: Boolean,
        default: true
      },
      taskAssignedPush: {
        type: Boolean,
        default: true
      },
      taskMovedEmail: {
        type: Boolean,
        default: true
      },
      taskMovedPush: {
        type: Boolean,
        default: true
      },
      taskCompletedEmail: {
        type: Boolean,
        default: false
      },
      taskCompletedPush: {
        type: Boolean,
        default: false
      }
    },
    boardPreferences: {
      defaultView: {
        type: String,
        enum: ['kanban', 'list'],
        default: 'kanban'
      },
      autoArchiveCompleted: {
        type: Boolean,
        default: false
      },
      taskSorting: {
        type: String,
        enum: ['due_date', 'priority', 'alphabetical', 'created_date'],
        default: 'due_date'
      }
    }
  }
}, {
  timestamps: true
});

// Indexes for better query performance
userSchema.index({ email: 1, isActive: 1 });
userSchema.index({ username: 1, isActive: 1 });
userSchema.index({ displayName: 'text', email: 'text', username: 'text' }); // For search functionality

// Instance methods
userSchema.methods.toJSON = function(): Partial<IUser> {
  const user = this.toObject();

  // Remove sensitive fields
  delete user.__v;
  delete user.password; // Never expose password

  return user;
};

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Search users static method
userSchema.statics.searchUsers = function(query: string, limit: number = 10): Promise<IUser[]> {
  return this.find({
    $and: [
      { isActive: true },
      {
        $or: [
          { username: { $regex: query, $options: 'i' } },
          { displayName: { $regex: query, $options: 'i' } },
          { email: { $regex: query, $options: 'i' } }
        ]
      }
    ]
  })
  .select('username email displayName photoURL role lastLoginAt')
  .limit(limit)
  .exec();
};

// Pre-save middleware
userSchema.pre('save', async function(next) {
  // Ensure email is lowercase
  if (this.isModified('email')) {
    this.email = this.email.toLowerCase();
  }

  // Set displayName from email if not provided
  if (this.isNew && !this.displayName) {
    this.displayName = this.email.split('@')[0];
  }

  // Hash password if it's modified
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  next();
});

// Virtual for checking if user is manager or admin
userSchema.virtual('isManager').get(function() {
  return ['manager', 'admin'].includes(this.role);
});

// Ensure virtual fields are serialized
userSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const User = mongoose.model<IUser, IUserModel>('User', userSchema);

// Add default export
export default User