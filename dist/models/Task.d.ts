import mongoose, { Document, Model } from 'mongoose';
export interface ITaskAttachment {
    id: string;
    name: string;
    url: string;
    type: string;
    size: number;
    uploadedBy: mongoose.Types.ObjectId;
    uploadedAt: Date;
}
export interface ITask extends Document {
    title: string;
    description?: string;
    status: string;
    listId: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    projectId: mongoose.Types.ObjectId;
    assigneeId?: mongoose.Types.ObjectId;
    assignedTo?: mongoose.Types.ObjectId;
    assignees: mongoose.Types.ObjectId[];
    assignedBy?: mongoose.Types.ObjectId;
    assignedAt?: Date;
    createdBy: mongoose.Types.ObjectId;
    dueDate?: Date;
    completedAt?: Date;
    reminderFrequency?: 'none' | '1hour' | '3hours' | '12hours' | '24hours' | '48hours';
    lastReminderSent?: Date;
    attachments: ITaskAttachment[];
    order: number;
    createdAt: Date;
    updatedAt: Date;
}
interface ITaskModel extends Model<ITask> {
    findByProject(projectId: string): Promise<ITask[]>;
    findByAssignee(userId: string): Promise<ITask[]>;
    reorderTasks(projectId: string, tasks: Array<{
        _id: string;
        status: string;
        order: number;
    }>): Promise<void>;
}
declare const Task: ITaskModel;
export default Task;
//# sourceMappingURL=Task.d.ts.map