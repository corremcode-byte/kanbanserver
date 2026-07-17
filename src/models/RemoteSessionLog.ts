import mongoose, { Schema, Document, Model } from 'mongoose';

export type RemoteSessionLogStatus =
  | 'opened'              // Session requested / connect initiated
  | 'auth_success'        // Guacamole authentication succeeded
  | 'auth_failed'         // Guacamole authentication failed
  | 'timeout'             // Connection attempt timed out
  | 'disconnected'        // Clean, user-initiated disconnect
  | 'unexpected_disconnect'; // Tunnel dropped without an explicit disconnect call

export interface IRemoteSessionLog extends Document {
  serverId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  loginTime: Date;
  logoutTime?: Date;
  status: RemoteSessionLogStatus;
  clientIp?: string;
  browser?: string;
  sessionDuration?: number; // seconds
  disconnectReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IRemoteSessionLogModel extends Model<IRemoteSessionLog> {
  findActiveForUser(userId: string): Promise<IRemoteSessionLog | null>;
}

const RemoteSessionLogSchema = new Schema<IRemoteSessionLog>(
  {
    serverId: {
      type: Schema.Types.ObjectId,
      ref: 'RemoteServer',
      required: true,
      index: true
    },
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

// Never persist Guacamole/target-machine credentials or tokens on this model —
// this table is an access/audit trail only (see remoteServerController).
RemoteSessionLogSchema.index({ userId: 1, createdAt: -1 });
RemoteSessionLogSchema.index({ serverId: 1, createdAt: -1 });

RemoteSessionLogSchema.statics.findActiveForUser = function (userId: string) {
  return this.findOne({
    userId,
    status: { $in: ['opened', 'auth_success'] },
    logoutTime: { $exists: false }
  }).sort({ createdAt: -1 });
};

const RemoteSessionLog = mongoose.model<IRemoteSessionLog, IRemoteSessionLogModel>(
  'RemoteSessionLog',
  RemoteSessionLogSchema
);

export default RemoteSessionLog;
