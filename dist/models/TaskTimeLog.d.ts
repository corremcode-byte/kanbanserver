import mongoose, { Document, Model } from 'mongoose';
export interface ITaskTimeLog extends Document {
    taskId: mongoose.Types.ObjectId;
    projectId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    timeSpent: number;
    description?: string;
    loggedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
interface ITaskTimeLogModel extends Model<ITaskTimeLog> {
    findByTask(taskId: string): Promise<ITaskTimeLog[]>;
    findByUser(userId: string, startDate?: Date, endDate?: Date): Promise<ITaskTimeLog[]>;
    findByProject(projectId: string, startDate?: Date, endDate?: Date): Promise<ITaskTimeLog[]>;
    getTotalTimeByTask(taskId: string): Promise<number>;
    getTotalTimeByUser(userId: string, startDate?: Date, endDate?: Date): Promise<number>;
}
export declare const TaskTimeLog: ITaskTimeLogModel;
export default TaskTimeLog;
//# sourceMappingURL=TaskTimeLog.d.ts.map