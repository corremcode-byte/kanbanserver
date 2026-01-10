import mongoose, { Document, Model } from 'mongoose';
export interface IProjectPermission extends Document {
    projectId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    role: 'owner' | 'manager' | 'assignee';
    permissions: {
        canCreateTasks: boolean;
        canEditTasks: boolean;
        canDeleteTasks: boolean;
        canAssignTasks: boolean;
        canEditProject: boolean;
        canManageMembers: boolean;
        canViewAllTasks: boolean;
        canManagePermissions: boolean;
        canCreateChatGroups: boolean;
        canDeleteChatGroups: boolean;
    };
    customPermissions?: Record<string, boolean>;
    createdAt: Date;
    updatedAt: Date;
}
interface IProjectPermissionModel extends Model<IProjectPermission> {
    getPermissions(projectId: string, userId: string): Promise<IProjectPermission | null>;
    getDefaultPermissions(role: 'owner' | 'manager' | 'assignee'): IProjectPermission['permissions'];
}
export declare const ProjectPermission: IProjectPermissionModel;
export default ProjectPermission;
//# sourceMappingURL=ProjectPermission.d.ts.map