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
const fixTask = async () => {
    try {
        const Task = mongoose_1.default.connection.collection('tasks');
        const task = await Task.findOne({ title: 'Lost of bugs' });
        if (!task) {
            console.log('❌ Task "Lost of bugs" not found');
            return;
        }
        console.log('\n📋 Found task:');
        console.log(`  Title: ${task.title}`);
        console.log(`  Current status: ${task.status}`);
        console.log(`  Current listId: ${task.listId}`);
        await Task.updateOne({ _id: task._id }, {
            $set: {
                status: 'in-progress',
                listId: 'in-progress'
            }
        });
        console.log('\n✅ Task updated:');
        console.log('  New status: in-progress');
        console.log('  New listId: in-progress');
    }
    catch (error) {
        console.error('❌ Error fixing task:', error);
        throw error;
    }
};
const main = async () => {
    console.log('🚀 Fixing "Lost of bugs" task...\n');
    await connectDB();
    await fixTask();
    await mongoose_1.default.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
    process.exit(0);
};
main().catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
});
//# sourceMappingURL=fixLostOfBugs.js.map