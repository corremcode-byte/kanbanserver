import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IProjectInvitation extends Document {
  projectId: mongoose.Types.ObjectId;
  invitedEmail: string;
  invitedBy: mongoose.Types.ObjectId;
  role: 'member' | 'assignee' | 'manager'; // All invited users are members (old values allowed for backward compatibility)
  permissions?: {
    canCreateTasks?: boolean;
    canEditTasks?: boolean;
    canDeleteTasks?: boolean;
    canAssignTasks?: boolean;
    canEditProject?: boolean;
    canManageMembers?: boolean;
    canViewAllTasks?: boolean;
    canManagePermissions?: boolean;
  };
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'completed';
  token: string;
  expiresAt: Date;
  acceptedAt?: Date;
  rejectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IProjectInvitationModel extends Model<IProjectInvitation> {
  findPendingByEmail(email: string): Promise<IProjectInvitation[]>;
  findByToken(token: string): Promise<IProjectInvitation | null>;
}

const ProjectInvitationSchema = new Schema<IProjectInvitation>({
  projectId: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  invitedEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  invitedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['member', 'assignee', 'manager'], // Allow old values for backward compatibility
    default: 'member',
    required: true
  },
  permissions: {
    type: {
      canCreateTasks: { type: Boolean, default: false },
      canEditTasks: { type: Boolean, default: false },
      canDeleteTasks: { type: Boolean, default: false },
      canAssignTasks: { type: Boolean, default: false },
      canEditProject: { type: Boolean, default: false },
      canManageMembers: { type: Boolean, default: false },
      canViewAllTasks: { type: Boolean, default: false },
      canManagePermissions: { type: Boolean, default: false }
    },
    required: false
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'expired', 'completed'],
    default: 'pending',
    index: true
  },
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
    default: () => {
      const d = new Date();
      d.setDate(d.getDate() + 7); // default to 7 days from now
      return d;
    }
  },
  acceptedAt: Date,
  rejectedAt: Date
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      // Don't expose token in JSON responses for security
      delete ret.token;
      return ret;
    }
  }
});

// Compound index for finding invitations
ProjectInvitationSchema.index({ projectId: 1, invitedEmail: 1, status: 1 });
ProjectInvitationSchema.index({ token: 1, expiresAt: 1 });

// Static method to find pending invitations by email
ProjectInvitationSchema.statics.findPendingByEmail = function(email: string): Promise<IProjectInvitation[]> {
  return this.find({
    invitedEmail: email.toLowerCase(),
    status: 'pending',
    expiresAt: { $gt: new Date() }
  })
    .populate('projectId', 'name description color')
    .populate('invitedBy', 'displayName email')
    .sort({ createdAt: -1 });
};

// Static method to find invitation by token
ProjectInvitationSchema.statics.findByToken = function(token: string): Promise<IProjectInvitation | null> {
  return this.findOne({
    token,
    status: 'pending',
    expiresAt: { $gt: new Date() }
  })
    .populate('projectId', 'name description color')
    .populate('invitedBy', 'displayName email');
};

// Pre-save hook to set expiration date (7 days from creation)
ProjectInvitationSchema.pre('save', function(next) {
  if (this.isNew && !this.expiresAt) {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 7); // 7 days expiration
    this.expiresAt = expirationDate;
  }
  next();
});

export const ProjectInvitation = mongoose.model<IProjectInvitation, IProjectInvitationModel>(
  'ProjectInvitation',
  ProjectInvitationSchema
);

export default ProjectInvitation;
