import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IUserServerPermission extends Document {
  serverId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  canConnect: boolean;
  grantedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface IUserServerPermissionModel extends Model<IUserServerPermission> {}

const UserServerPermissionSchema = new Schema<IUserServerPermission>(
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
    canConnect: {
      type: Boolean,
      default: true
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// One permission record per user per server.
UserServerPermissionSchema.index({ serverId: 1, userId: 1 }, { unique: true });

export const UserServerPermission = mongoose.model<IUserServerPermission, IUserServerPermissionModel>(
  'UserServerPermission',
  UserServerPermissionSchema
);

export default UserServerPermission;
