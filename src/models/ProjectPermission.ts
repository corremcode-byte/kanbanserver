import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IProjectPermission extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: 'owner' | 'manager' | 'assignee';
  permissions: {
    canCreateTasks: boolean;
    canEditTasks: boolean;
    canDeleteTasks: boolean;
    canAssignTasks: boolean;
    canEditProject: boolean;
    canManageMembers: boolean;
    canViewAllTasks: boolean; // false = can only see own tasks
    canManagePermissions: boolean;
  };
  customPermissions?: Record<string, boolean>; // For future extensibility
  createdAt: Date;
  updatedAt: Date;
}

interface IProjectPermissionModel extends Model<IProjectPermission> {
  getPermissions(projectId: string, userId: string): Promise<IProjectPermission | null>;
  getDefaultPermissions(role: 'owner' | 'manager' | 'assignee'): IProjectPermission['permissions'];
}

const ProjectPermissionSchema = new Schema<IProjectPermission>({
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
  role: {
    type: String,
    enum: ['owner', 'manager', 'assignee'],
    required: true
  },
  permissions: {
    canCreateTasks: { type: Boolean, default: false },
    canEditTasks: { type: Boolean, default: false },
    canDeleteTasks: { type: Boolean, default: false },
    canAssignTasks: { type: Boolean, default: false },
    canEditProject: { type: Boolean, default: false },
    canManageMembers: { type: Boolean, default: false },
    canViewAllTasks: { type: Boolean, default: false },
    canManagePermissions: { type: Boolean, default: false }
  },
  customPermissions: {
    type: Map,
    of: Boolean,
    default: {}
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

// Compound unique index - one permission record per user per project
ProjectPermissionSchema.index({ projectId: 1, userId: 1 }, { unique: true });

// Static method to get permissions
ProjectPermissionSchema.statics.getPermissions = function(
  projectId: string,
  userId: string
): Promise<IProjectPermission | null> {
  return this.findOne({ projectId, userId });
};

// Static method to get default permissions based on role
ProjectPermissionSchema.statics.getDefaultPermissions = function(
  role: 'owner' | 'manager' | 'assignee'
): IProjectPermission['permissions'] {
  const defaults = {
    owner: {
      canCreateTasks: true,
      canEditTasks: true,
      canDeleteTasks: true,
      canAssignTasks: true,
      canEditProject: true,
      canManageMembers: true,
      canViewAllTasks: true,
      canManagePermissions: true
    },
    manager: {
      canCreateTasks: true,
      canEditTasks: true,
      canDeleteTasks: true,
      canAssignTasks: true,
      canEditProject: false,
      canManageMembers: false,
      canViewAllTasks: true,
      canManagePermissions: false
    },
    assignee: {
      canCreateTasks: false,
      canEditTasks: true, // Can edit only own tasks (enforced in middleware)
      canDeleteTasks: false,
      canAssignTasks: false,
      canEditProject: false,
      canManageMembers: false,
      canViewAllTasks: false, // Can only view own tasks
      canManagePermissions: false
    }
  };

  return defaults[role];
};

// Pre-save hook to set default permissions based on role
ProjectPermissionSchema.pre('save', function(next) {
  if (this.isNew) {
    const defaultPerms = (this.constructor as IProjectPermissionModel).getDefaultPermissions(this.role);
    this.permissions = { ...defaultPerms, ...this.permissions };
  }
  next();
});

export const ProjectPermission = mongoose.model<IProjectPermission, IProjectPermissionModel>(
  'ProjectPermission',
  ProjectPermissionSchema
);

export default ProjectPermission;
