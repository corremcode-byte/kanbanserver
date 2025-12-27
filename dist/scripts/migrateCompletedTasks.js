"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
const models_1 = require("../models");
dotenv_1.default.config();
const migrateCompletedTasks = async () => {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose_1.default.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/asana-clone');
        console.log('Connected successfully!');
        const tasksToUpdate = await models_1.Task.find({
            $or: [
                { status: 'done' },
                { status: 'completed' }
            ],
            completedAt: { $exists: false }
        });
        console.log(`Found ${tasksToUpdate.length} completed tasks without completedAt timestamp`);
        for (const task of tasksToUpdate) {
            const completedAt = task.updatedAt || task.createdAt;
            await models_1.Task.findByIdAndUpdate(task._id, {
                completedAt: completedAt
            });
            console.log(`✓ Updated task: ${task.title} (completedAt: ${completedAt})`);
        }
        const tasksWithoutAssignedAt = await models_1.Task.find({
            assignees: { $exists: true, $ne: [] },
            assignedAt: { $exists: false }
        });
        console.log(`\nFound ${tasksWithoutAssignedAt.length} tasks with assignees but no assignedAt`);
        for (const task of tasksWithoutAssignedAt) {
            await models_1.Task.findByIdAndUpdate(task._id, {
                assignedAt: task.createdAt
            });
            console.log(`✓ Set assignedAt for task: ${task.title}`);
        }
        console.log('\n✅ Migration completed successfully!');
        console.log(`Total tasks updated: ${tasksToUpdate.length + tasksWithoutAssignedAt.length}`);
        await mongoose_1.default.connection.close();
        process.exit(0);
    }
    catch (error) {
        console.error('❌ Migration failed:', error);
        await mongoose_1.default.connection.close();
        process.exit(1);
    }
};
migrateCompletedTasks();
//# sourceMappingURL=migrateCompletedTasks.js.map