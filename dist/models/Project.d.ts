import mongoose, { Document, Model } from 'mongoose';
export interface IProject extends Document {
    name: string;
    description?: string;
    status: 'active' | 'on-hold' | 'completed' | 'archived';
    color?: string;
    ownerId: mongoose.Types.ObjectId;
    owners: mongoose.Types.ObjectId[];
    members: mongoose.Types.ObjectId[];
    managers: mongoose.Types.ObjectId[];
    columns: Array<{
        id: string;
        title: string;
        color?: string;
        order: number;
    }>;
    createdAt: Date;
    updatedAt: Date;
}
interface IProjectModel extends Model<IProject> {
    findByUser(userId: string): Promise<IProject[]>;
}
declare const Project: IProjectModel;
export default Project;
//# sourceMappingURL=Project.d.ts.map