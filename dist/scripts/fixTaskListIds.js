"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
const connectDB = async () => {
    try {
        const mongoURI = process.env.MONGODB_URI;
        if (!mongoURI) {
            throw new Error('MONGODB_URI not found in environment variables');
        }
        await mongoose_1.default.connect(mongoURI);
        console.log('✅ Connected to MongoDB');
    }
    catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
};
const normalizeStatus = (status) => {
    const normalized = status.toLowerCase().trim();
    if (normalized === 'in_progress')
        return 'in-progress';
    if (normalized === 'done')
        return 'completed';
    return status;
};
const fixAllTasks = async () => {
    try {
        const Task = mongoose_1.default.connection.collection('tasks');
        const tasks = await Task.find({}).toArray();
        console.log(`\n📊 Found ${tasks.length} tasks to check`);
        let updatedCount = 0;
        let alreadyCorrectCount = 0;
        for (const task of tasks) {
            const currentStatus = task.status || 'todo';
            const currentListId = task.listId || task.status || 'todo';
            const normalizedStatus = normalizeStatus(currentStatus);
            const normalizedListId = normalizeStatus(currentListId);
            const needsUpdate = task.status !== normalizedStatus ||
                task.listId !== normalizedListId ||
                task.status !== task.listId;
            if (needsUpdate) {
                console.log(`\n🔧 Fixing task: "${task.title}"`);
                console.log(`   Before: status="${task.status}", listId="${task.listId}"`);
                await Task.updateOne({ _id: task._id }, {
                    $set: {
                        status: normalizedStatus,
                        listId: normalizedStatus
                    }
                });
                console.log(`   After:  status="${normalizedStatus}", listId="${normalizedStatus}"`);
                updatedCount++;
            }
            else {
                alreadyCorrectCount++;
            }
        }
        console.log(`\n✨ Migration complete!`);
        console.log(`   ✅ Updated: ${updatedCount} tasks`);
        console.log(`   ✓  Already correct: ${alreadyCorrectCount} tasks`);
        console.log(`   📊 Total: ${tasks.length} tasks\n`);
    }
    catch (error) {
        console.error('❌ Error fixing tasks:', error);
        throw error;
    }
};
const main = async () => {
    console.log('🚀 Starting task listId migration...\n');
    await connectDB();
    await fixAllTasks();
    await mongoose_1.default.disconnect();
    console.log('👋 Disconnected from MongoDB');
    process.exit(0);
};
main().catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
});
//# sourceMappingURL=fixTaskListIds.js.map