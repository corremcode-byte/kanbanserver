import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from '../utils/encryption';

export interface IPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface IUser extends Document {
  userId: string;    // System-generated unique ID (e.g. USR-A1B2C3)
  username: string;  // Set to email at creation, immutable
  email: string;
  password: string;
  plainPassword?: string;  // Plain text password for admin viewing
  passkey?: string;  // Encrypted passkey for app access (like payment app PIN)
  displayName: string;
  photoURL?: string;
  bio?: string;
  role: 'superadmin' | 'admin' | 'manager' | 'member';
  isActive: boolean;
  lastLoginAt: Date;
  lastLogoutAt?: Date;
  pushSubscriptions?: IPushSubscription[];
  webauthnCredentials?: Array<{
    credentialID: string;
    credentialPublicKey: string;
    counter: number;
    transports?: string[];
  }>;
  currentChallenge?: string;
  faceDescriptor?: number[];
  comparePassword(candidatePassword: string): Promise<boolean>;
  comparePasskey(candidatePasskey: string): Promise<boolean>;
  hasPasskey(): boolean;
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
  userId: {
    type: String,
    unique: true,
    index: true,
    // Generated in pre-save hook
  },
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
    immutable: true,  // Set to email at creation, cannot be changed
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
  plainPassword: {
    type: String,
    select: false // Don't include in normal queries, only for admin
  },
  passkey: {
    type: String,
    select: false
  },
  webauthnCredentials: [{
    credentialID:        { type: String, required: true },
    credentialPublicKey: { type: String, required: true },
    counter:             { type: Number, default: 0 },
    transports:          [{ type: String }],
  }],
  currentChallenge: {
    type: String,
    select: false,
  },
  faceDescriptor: {
    type: [Number],
    select: false,
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
    enum: ['superadmin', 'admin', 'manager', 'member'],
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
  lastLogoutAt: {
    type: Date
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
  delete user.password; // Never expose hashed password
  delete user.plainPassword; // Never expose plain password in normal responses

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

// Compare passkey method (decrypts stored passkey and compares)
userSchema.methods.comparePasskey = async function(candidatePasskey: string): Promise<boolean> {
  try {
    if (!this.passkey) return false;
    const decryptedPasskey = decrypt(this.passkey);
    return decryptedPasskey === candidatePasskey;
  } catch (error) {
    return false;
  }
};

// Check if user has set a passkey
userSchema.methods.hasPasskey = function(): boolean {
  return !!this.passkey;
};

// Search users static method
userSchema.statics.searchUsers = function(query: string, limit: number = 10): Promise<IUser[]> {
  return this.find({
    $and: [
      { isActive: true },
      { role: { $ne: 'superadmin' } },
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

// Generate a unique userId like USR-A1B2C3
function generateUserId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'USR-';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// Pre-save middleware
userSchema.pre('save', async function(next) {
  // Ensure email is lowercase
  if (this.isModified('email')) {
    this.email = this.email.toLowerCase();
  }

  // Auto-generate unique userId on first save
  if (this.isNew && !this.userId) {
    let uid = generateUserId();
    // Retry on collision (extremely rare)
    while (await (this.constructor as IUserModel).findOne({ userId: uid })) {
      uid = generateUserId();
    }
    this.userId = uid;
  }

  // Set displayName from email if not provided
  if (this.isNew && !this.displayName) {
    this.displayName = this.email.split('@')[0];
  }

  // Store encrypted password before hashing (for admin viewing)
  // Only if password is being modified and plainPassword wasn't explicitly set
  if (this.isModified('password') && !this.isModified('plainPassword')) {
    this.plainPassword = encrypt(this.password);
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
  return ['manager', 'admin', 'superadmin'].includes(this.role);
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