import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IProject extends Document {
  name: string;
  description?: string;
  status: 'active' | 'on-hold' | 'completed' | 'archived';
  color?: string;
  ownerId: mongoose.Types.ObjectId; // Keep for backward compatibility
  owners: mongoose.Types.ObjectId[]; // Project owners (full access)
  members: mongoose.Types.ObjectId[]; // Regular members
  managers: mongoose.Types.ObjectId[]; // Project managers
  columns: Array<{
    id: string;
    title: string;
    color?: string;
    order: number;
    assignedMembers?: mongoose.Types.ObjectId[];
  }>;
  createdAt: Date;
  updatedAt: Date;
}

interface IProjectModel extends Model<IProject> {
  findByUser(userId: string): Promise<IProject[]>;
}

const ProjectSchema = new Schema<IProject>({
  name: { 
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
    enum: ['active', 'on-hold', 'completed', 'archived'],
    default: 'active'
  },
  color: { 
    type: String, 
    default: '#3B82F6' 
  },
  ownerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  owners: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  members: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  managers: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  columns: [{
    id: { type: String, required: true },
    title: { type: String, required: true },
    color: { type: String },
    order: { type: Number, default: 0 },
    assignedMembers: [{ type: Schema.Types.ObjectId, ref: 'User' }]
  }]
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

// Default columns for kanban board
ProjectSchema.pre('save', function(next) {
  if (this.isNew && (!this.columns || this.columns.length === 0)) {
    this.columns = [
      { id: 'todo', title: 'To Do', color: '#6B7280', order: 0 },
      { id: 'in-progress', title: 'In Progress', color: '#3B82F6', order: 1 },
      { id: 'completed', title: 'Completed', color: '#10B981', order: 2 }
    ];
  }
  next();
});

// Find projects by user (either as owner, manager, or member)
ProjectSchema.statics.findByUser = function(userId: string): Promise<IProject[]> {
  return this.find({
    $or: [
      { ownerId: userId },
      { members: userId },
      { managers: userId }
    ]
  }).sort({ updatedAt: -1 });
};

const Project = mongoose.model<IProject, IProjectModel>('Project', ProjectSchema);
export default Project;