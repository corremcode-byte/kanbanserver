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
const checkTasks = async () => {
    try {
        const Task = mongoose_1.default.connection.collection('tasks');
        const tasks = await Task.find({}).toArray();
        console.log(`\n📊 Found ${tasks.length} tasks\n`);
        tasks.forEach((task) => {
            console.log(`Task: "${task.title}"`);
            console.log(`  status: ${task.status}`);
            console.log(`  listId: ${task.listId}`);
            console.log(`  createdAt: ${task.createdAt}`);
            console.log(`  updatedAt: ${task.updatedAt}`);
            console.log('---');
        });
    }
    catch (error) {
        console.error('❌ Error checking tasks:', error);
        throw error;
    }
};
const main = async () => {
    console.log('🚀 Checking tasks...\n');
    await connectDB();
    await checkTasks();
    await mongoose_1.default.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
    process.exit(0);
};
main().catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
});
//# sourceMappingURL=checkTasks.js.map