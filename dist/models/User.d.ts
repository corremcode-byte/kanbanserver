import { Document, Model } from 'mongoose';
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
export declare const User: IUserModel;
export default User;
//# sourceMappingURL=User.d.ts.map