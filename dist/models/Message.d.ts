import mongoose, { Document } from 'mongoose';
export interface IMessage extends Document {
    groupId: mongoose.Types.ObjectId;
    senderId: mongoose.Types.ObjectId;
    encryptedContent: string;
    nonce: string;
    attachments?: {
        fileName: string;
        fileUrl: string;
        fileType: string;
        fileSize: number;
    }[];
    replyTo?: mongoose.Types.ObjectId;
    readBy: {
        userId: mongoose.Types.ObjectId;
        readAt: Date;
    }[];
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export declare const Message: mongoose.Model<IMessage, {}, {}, {}, mongoose.Document<unknown, {}, IMessage, {}, {}> & IMessage & Required<{
    _id: unknown;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=Message.d.ts.map