import cron, { ScheduledTask } from 'node-cron';
import Task from '../models/Task';
import User from '../models/User';
import Project from '../models/Project';
import { emailService } from './emailService';
import { logger } from '../utils/logger';

class CronService {
  private tasks: Map<string, ScheduledTask> = new Map();

  /**
   * Start all cron jobs
   */
  start() {
    this.startTaskDeadlineReminders();
    logger.info('Cron service started');
  }

  /**
   * Stop all cron jobs
   */
  stop() {
    this.tasks.forEach((task, name) => {
      task.stop();
      logger.info(`Stopped cron job: ${name}`);
    });
    this.tasks.clear();
  }

  /**
   * Check for upcoming task deadlines and send reminders
   * Runs every hour
   */
  private startTaskDeadlineReminders() {
    // Run every hour at the start of the hour
    const task = cron.schedule('0 * * * *', async () => {
      try {
        logger.info('Running task deadline reminder check...');
        await this.checkTaskDeadlines();
      } catch (error) {
        logger.error('Error in task deadline reminder cron job:', error);
      }
    });

    this.tasks.set('taskDeadlineReminders', task);
    logger.info('Task deadline reminder cron job scheduled (runs every hour)');
  }

  /**
   * Check tasks and send reminders based on custom frequency settings
   */
  private async checkTaskDeadlines() {
    const now = new Date();

    try {
      // Find tasks that are not completed and have due dates
      const tasks = await Task.find({
        status: { $ne: 'completed' },
        dueDate: { $exists: true, $ne: null },
        reminderFrequency: { $ne: 'none' }
      })
        .populate('assignees', 'email name')
        .populate('assignedTo', 'email name')
        .populate('projectId', 'name')
        .lean();

      logger.info(`Found ${tasks.length} tasks to check for reminders`);

      for (const task of tasks) {
        const dueDate = new Date(task.dueDate!);
        const reminderFreq = task.reminderFrequency || '24hours';
        const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;

        // Calculate hours until due
        const hoursUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60));

        // Determine if we should send reminder based on frequency
        let shouldSend = false;
        let frequencyMinutes = 1440; // default (24 hours in minutes)

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

        // Check if it's time to send based on last reminder sent
        if (lastReminder) {
          const minutesSinceLastReminder = Math.floor((now.getTime() - lastReminder.getTime()) / (1000 * 60));
          if (minutesSinceLastReminder >= frequencyMinutes) {
            shouldSend = true;
          }
        } else {
          // No reminder sent yet, send if within reminder window
          const minutesUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60));
          if (minutesUntilDue <= frequencyMinutes && minutesUntilDue > -1440) {
            shouldSend = true;
          }
        }

        // Always send for overdue tasks (but respect frequency)
        if (hoursUntilDue < 0 && shouldSend) {
          shouldSend = true;
        }

        if (!shouldSend) continue;

        // Get all assignees
        const recipients: string[] = [];

        if (task.assignees && Array.isArray(task.assignees)) {
          task.assignees.forEach((assignee: any) => {
            if (assignee && assignee.email) {
              recipients.push(assignee.email);
            }
          });
        }

        if (task.assignedTo && typeof task.assignedTo === 'object' && (task.assignedTo as any).email) {
          const email = (task.assignedTo as any).email;
          if (!recipients.includes(email)) {
            recipients.push(email);
          }
        }

        if (recipients.length === 0) {
          logger.warn(`Task ${task._id} has no assignees to notify`);
          continue;
        }

        // Send reminder email
        const projectName = typeof task.projectId === 'object' && (task.projectId as any).name
          ? (task.projectId as any).name
          : 'Unknown Project';

        await emailService.sendTaskDeadlineReminder(recipients, {
          taskTitle: task.title,
          taskId: task._id.toString(),
          projectName,
          projectId: typeof task.projectId === 'object' && (task.projectId as any)._id
            ? (task.projectId as any)._id.toString()
            : task.projectId.toString(),
          dueDate,
          priority: task.priority
        });

        // Update lastReminderSent timestamp
        await Task.findByIdAndUpdate(task._id, {
          lastReminderSent: new Date()
        });

        logger.info(`Sent deadline reminder for task "${task.title}" to ${recipients.join(', ')}`);
      }
    } catch (error) {
      logger.error('Error checking task deadlines:', error);
    }
  }

  /**
   * Manually trigger task deadline check (for testing)
   */
  async manualCheckDeadlines() {
    logger.info('Manually triggering task deadline check...');
    await this.checkTaskDeadlines();
  }
}

// Export singleton instance
export const cronService = new CronService();
