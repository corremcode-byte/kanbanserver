import mongoose, { Document, Model } from 'mongoose';
export interface IAuditLog extends Document {
    projectId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    action: 'task_created' | 'task_updated' | 'task_deleted' | 'task_assigned' | 'task_status_changed' | 'task_completed' | 'member_added' | 'member_removed' | 'permission_changed' | 'project_updated' | 'time_logged' | 'comment_added' | 'comment_updated' | 'comment_deleted' | 'chat_group_created' | 'chat_group_deleted';
    entityType: 'task' | 'project' | 'member' | 'permission' | 'comment' | 'time_log' | 'chat_group';
    entityId?: mongoose.Types.ObjectId;
    metadata?: {
        taskId?: string;
        taskTitle?: string;
        oldStatus?: string;
        newStatus?: string;
        oldValue?: string;
        newValue?: string;
        assigneeId?: string;
        assigneeName?: string;
        duration?: number;
        [key: string]: any;
    };
    createdAt: Date;
}
interface IAuditLogModel extends Model<IAuditLog> {
    logAction(data: {
        projectId: string;
        userId: string;
        action: IAuditLog['action'];
        entityType: IAuditLog['entityType'];
        entityId?: string;
        metadata?: IAuditLog['metadata'];
    }): Promise<IAuditLog>;
    getProjectActivity(projectId: string, options?: {
        userId?: string;
        action?: string;
        startDate?: Date;
        endDate?: Date;
        limit?: number;
    }): Promise<IAuditLog[]>;
    getUserStats(projectId: string, userId: string, startDate: Date, endDate: Date): Promise<{
        tasksCompleted: number;
        tasksCreated: number;
        tasksUpdated: number;
        totalTimeLogged: number;
        actionsCount: number;
    }>;
}
export declare const AuditLog: IAuditLogModel;
export default AuditLog;
//# sourceMappingURL=AuditLog.d.ts.map