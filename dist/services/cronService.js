"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cronService = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const Task_1 = __importDefault(require("../models/Task"));
const emailService_1 = require("./emailService");
const logger_1 = require("../utils/logger");
class CronService {
    constructor() {
        this.tasks = new Map();
    }
    start() {
        this.startTaskDeadlineReminders();
        logger_1.logger.info('Cron service started');
    }
    stop() {
        this.tasks.forEach((task, name) => {
            task.stop();
            logger_1.logger.info(`Stopped cron job: ${name}`);
        });
        this.tasks.clear();
    }
    startTaskDeadlineReminders() {
        const task = node_cron_1.default.schedule('0 * * * *', async () => {
            try {
                logger_1.logger.info('Running task deadline reminder check...');
                await this.checkTaskDeadlines();
            }
            catch (error) {
                logger_1.logger.error('Error in task deadline reminder cron job:', error);
            }
        });
        this.tasks.set('taskDeadlineReminders', task);
        logger_1.logger.info('Task deadline reminder cron job scheduled (runs every hour)');
    }
    async checkTaskDeadlines() {
        const now = new Date();
        try {
            const tasks = await Task_1.default.find({
                status: { $ne: 'completed' },
                dueDate: { $exists: true, $ne: null },
                reminderFrequency: { $ne: 'none' }
            })
                .populate('assignees', 'email name')
                .populate('assignedTo', 'email name')
                .populate('projectId', 'name')
                .lean();
            logger_1.logger.info(`Found ${tasks.length} tasks to check for reminders`);
            for (const task of tasks) {
                const dueDate = new Date(task.dueDate);
                const reminderFreq = task.reminderFrequency || '24hours';
                const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;
                const hoursUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60));
                let shouldSend = false;
                let frequencyMinutes = 1440;
                switch (reminderFreq) {
                    case '1hour':
                        frequencyMinutes = 60;
                        break;
                    case '3hours':
                        frequencyMinutes = 180;
                        break;
                    case '12hours':
                        frequencyMinutes = 720;
                        break;
                    case '24hours':
                        frequencyMinutes = 1440;
                        break;
                    case '48hours':
                        frequencyMinutes = 2880;
                        break;
                }
                if (lastReminder) {
                    const minutesSinceLastReminder = Math.floor((now.getTime() - lastReminder.getTime()) / (1000 * 60));
                    if (minutesSinceLastReminder >= frequencyMinutes) {
                        shouldSend = true;
                    }
                }
                else {
                    const minutesUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60));
                    if (minutesUntilDue <= frequencyMinutes && minutesUntilDue > -1440) {
                        shouldSend = true;
                    }
                }
                if (hoursUntilDue < 0 && shouldSend) {
                    shouldSend = true;
                }
                if (!shouldSend)
                    continue;
                const recipients = [];
                if (task.assignees && Array.isArray(task.assignees)) {
                    task.assignees.forEach((assignee) => {
                        if (assignee && assignee.email) {
                            recipients.push(assignee.email);
                        }
                    });
                }
                if (task.assignedTo && typeof task.assignedTo === 'object' && task.assignedTo.email) {
                    const email = task.assignedTo.email;
                    if (!recipients.includes(email)) {
                        recipients.push(email);
                    }
                }
                if (recipients.length === 0) {
                    logger_1.logger.warn(`Task ${task._id} has no assignees to notify`);
                    continue;
                }
                const projectName = typeof task.projectId === 'object' && task.projectId.name
                    ? task.projectId.name
                    : 'Unknown Project';
                await emailService_1.emailService.sendTaskDeadlineReminder(recipients, {
                    taskTitle: task.title,
                    taskId: task._id.toString(),
                    projectName,
                    projectId: typeof task.projectId === 'object' && task.projectId._id
                        ? task.projectId._id.toString()
                        : task.projectId.toString(),
                    dueDate,
                    priority: task.priority
                });
                await Task_1.default.findByIdAndUpdate(task._id, {
                    lastReminderSent: new Date()
                });
                logger_1.logger.info(`Sent deadline reminder for task "${task.title}" to ${recipients.join(', ')}`);
            }
        }
        catch (error) {
            logger_1.logger.error('Error checking task deadlines:', error);
        }
    }
    async manualCheckDeadlines() {
        logger_1.logger.info('Manually triggering task deadline check...');
        await this.checkTaskDeadlines();
    }
}
exports.cronService = new CronService();
//# sourceMappingURL=cronService.js.map