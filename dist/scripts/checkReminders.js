"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const Task_1 = __importDefault(require("../models/Task"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function checkTasks() {
    try {
        await mongoose_1.default.connect(process.env.MONGODB_URI || '');
        console.log('Connected to MongoDB\n');
        const tasks = await Task_1.default.find({
            dueDate: { $exists: true, $ne: null }
        })
            .select('title dueDate reminderFrequency lastReminderSent assignees assignedTo status')
            .lean();
        console.log('Total tasks with due dates:', tasks.length);
        console.log('\n=== Tasks Details ===');
        tasks.forEach((task) => {
            console.log('\n-----------------------------------');
            console.log('Title:', task.title);
            console.log('Status:', task.status);
            console.log('Due Date:', task.dueDate);
            console.log('Reminder Frequency:', task.reminderFrequency || 'Not set');
            console.log('Last Reminder Sent:', task.lastReminderSent || 'Never');
            console.log('Assignees count:', task.assignees?.length || 0);
            console.log('Has assignedTo:', task.assignedTo ? 'Yes' : 'No');
            const now = new Date();
            const dueDate = new Date(task.dueDate);
            const minutesUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60));
            if (minutesUntilDue < 0) {
                console.log('⚠️  OVERDUE by', Math.abs(minutesUntilDue), 'minutes');
            }
            else {
                const days = Math.floor(minutesUntilDue / (24 * 60));
                const hours = Math.floor((minutesUntilDue % (24 * 60)) / 60);
                const mins = minutesUntilDue % 60;
                console.log('⏰ Due in:', days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`);
            }
        });
        await mongoose_1.default.connection.close();
        console.log('\n\nDatabase connection closed');
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}
checkTasks();
//# sourceMappingURL=checkReminders.js.map