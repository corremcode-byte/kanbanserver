import mongoose, { Document, Model } from 'mongoose';
export interface IProjectInvitation extends Document {
    projectId: mongoose.Types.ObjectId;
    invitedEmail: string;
    invitedBy: mongoose.Types.ObjectId;
    role: 'assignee' | 'manager';
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
export declare const ProjectInvitation: IProjectInvitationModel;
export default ProjectInvitation;
//# sourceMappingURL=ProjectInvitation.d.ts.map