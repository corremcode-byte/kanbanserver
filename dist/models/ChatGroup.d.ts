import mongoose, { Document } from 'mongoose';
export interface IChatGroup extends Document {
    name: string;
    description?: string;
    createdBy: mongoose.Types.ObjectId;
    members: mongoose.Types.ObjectId[];
    encryptionPublicKey: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export declare const ChatGroup: mongoose.Model<IChatGroup, {}, {}, {}, mongoose.Document<unknown, {}, IChatGroup, {}, {}> & IChatGroup & Required<{
    _id: unknown;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=ChatGroup.d.ts.map