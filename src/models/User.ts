import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IUser extends Document {
  firebaseUid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  bio?: string;
  role: 'admin' | 'manager' | 'member';
  isActive: boolean;
  lastLoginAt: Date;
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
  findByFirebaseUid(firebaseUid: string): Promise<IUser | null>;
  searchUsers(query: string, limit?: number): Promise<IUser[]>;
}

const userSchema = new Schema<IUser, IUserModel, IUserMethods>({
  firebaseUid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
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
userSchema.index({ firebaseUid: 1, isActive: 1 });
userSchema.index({ displayName: 'text', email: 'text' }); // For search functionality

// Instance methods
userSchema.methods.toJSON = function(): Partial<IUser> {
  const user = this.toObject();
  
  // Remove sensitive fields
  delete user.__v;
  
  return user;
};

// Static methods
userSchema.statics.findByFirebaseUid = function(firebaseUid: string) {
  return this.findOne({ firebaseUid, isActive: true });
};

// Search users static method
userSchema.statics.searchUsers = function(query: string, limit: number = 10): Promise<IUser[]> {
  return this.find({
    $and: [
      { isActive: true },
      {
        $or: [
          { displayName: { $regex: query, $options: 'i' } },
          { email: { $regex: query, $options: 'i' } }
        ]
      }
    ]
  })
  .select('firebaseUid email displayName photoURL role lastLoginAt')
  .limit(limit)
  .exec();
};

// Pre-save middleware
userSchema.pre('save', function(next) {
  // Ensure email is lowercase
  if (this.isModified('email')) {
    this.email = this.email.toLowerCase();
  }
  
  // Set displayName from email if not provided
  if (this.isNew && !this.displayName) {
    this.displayName = this.email.split('@')[0];
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