import mongoose, { Schema, Document, Model } from 'mongoose';

export type RemoteServerProtocol = 'rdp' | 'vnc' | 'ssh' | 'telnet';

export interface IRemoteServer extends Document {
  name: string;
  description?: string;
  protocol: RemoteServerProtocol;
  hostname: string;
  port: number;
  domain?: string;
  usernameEncrypted?: string;
  passwordEncrypted?: string;
  privateKeyEncrypted?: string;
  passphraseEncrypted?: string;
  protocolParams?: Record<string, unknown>;
  // Set once the connection is provisioned in Guacamole via guacamoleApiService.
  // Never returned in any API response — see toJSON transform below.
  guacamoleConnectionId?: string;
  guacamoleDataSource?: string;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface IRemoteServerModel extends Model<IRemoteServer> {}

const RemoteServerSchema = new Schema<IRemoteServer>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ''
    },
    protocol: {
      type: String,
      enum: ['rdp', 'vnc', 'ssh', 'telnet'],
      required: true
    },
    hostname: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255
    },
    port: {
      type: Number,
      required: true,
      min: 1,
      max: 65535
    },
    domain: {
      type: String,
      trim: true,
      maxlength: 255
    },
    usernameEncrypted: {
      type: String,
      select: false
    },
    passwordEncrypted: {
      type: String,
      select: false
    },
    privateKeyEncrypted: {
      type: String,
      select: false
    },
    passphraseEncrypted: {
      type: String,
      select: false
    },
    protocolParams: {
      type: Schema.Types.Mixed,
      default: {}
    },
    guacamoleConnectionId: {
      type: String,
      select: false
    },
    guacamoleDataSource: {
      type: String,
      select: false
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // Defense in depth alongside select:false — these must never leave the server.
        delete ret.usernameEncrypted;
        delete ret.passwordEncrypted;
        delete ret.privateKeyEncrypted;
        delete ret.passphraseEncrypted;
        delete ret.guacamoleConnectionId;
        delete ret.guacamoleDataSource;
        return ret;
      }
    }
  }
);

RemoteServerSchema.index({ isActive: 1 });

export const RemoteServer = mongoose.model<IRemoteServer, IRemoteServerModel>('RemoteServer', RemoteServerSchema);

export default RemoteServer;
