import mongoose, { Schema, Document, Model } from 'mongoose';

export type ConnectionLogStatus =
  | 'opened'              // Workspace page opened / connect initiated
  | 'auth_success'        // Guacamole authentication succeeded
  | 'auth_failed'         // Guacamole authentication failed
  | 'timeout'             // Connection attempt timed out
  | 'disconnected'        // Clean, user-initiated disconnect
  | 'unexpected_disconnect'; // Tunnel dropped without an explicit disconnect call

export interface IConnectionLog extends Document {
  userId: mongoose.Types.ObjectId;
  loginTime: Date;
  logoutTime?: Date;
  status: ConnectionLogStatus;
  clientIp?: string;
  browser?: string;
  sessionDuration?: number; // seconds
  disconnectReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IConnectionLogModel extends Model<IConnectionLog> {
  findActiveForUser(userId: string): Promise<IConnectionLog | null>;
}

const ConnectionLogSchema = new Schema<IConnectionLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    loginTime: {
      type: Date,
      required: true,
      default: Date.now
    },
    logoutTime: {
      type: Date
    },
    status: {
      type: String,
      enum: ['opened', 'auth_success', 'auth_failed', 'timeout', 'disconnected', 'unexpected_disconnect'],
      required: true,
      index: true
    },
    clientIp: {
      type: String,
      trim: true
    },
    browser: {
      type: String,
      trim: true,
      maxlength: 300
    },
    sessionDuration: {
      type: Number,
      min: 0
    },
    disconnectReason: {
      type: String,
      trim: true,
      maxlength: 300
    }
  },
  {
    timestamps: true
  }
);

// Never persist Windows/Guacamole credentials or tokens on this model — this
// table is an access/audit trail only (see remoteWorkspaceController).
ConnectionLogSchema.index({ userId: 1, createdAt: -1 });

ConnectionLogSchema.statics.findActiveForUser = function (userId: string) {
  return this.findOne({
    userId,
    status: { $in: ['opened', 'auth_success'] },
    logoutTime: { $exists: false }
  }).sort({ createdAt: -1 });
};

const ConnectionLog = mongoose.model<IConnectionLog, IConnectionLogModel>('ConnectionLog', ConnectionLogSchema);

export default ConnectionLog;
