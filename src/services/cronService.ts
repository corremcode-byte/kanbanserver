import cron, { ScheduledTask } from 'node-cron';
import Task from '../models/Task';
import Note from '../models/Note';
import User from '../models/User';
import Project from '../models/Project';
import { emailService } from './emailService';
import { logger } from '../utils/logger';
import { createNotification } from '../controllers/notificationController';

class CronService {
  private tasks: Map<string, ScheduledTask> = new Map();

  /**
   * Start all cron jobs
   */
  async start() {
    await this.clearStaleReminderEndTimes();
    this.startTaskDeadlineReminders();
    logger.info('Cron service started');
  }

  /**
   * One-time cleanup: clear reminderEndTime from all tasks (no longer used in UI)
   * and reset lastReminderSent for tasks that have a future startTime so they
   * don't get stuck waiting for a frequency gap that never resets.
   */
  private async clearStaleReminderEndTimes() {
    try {
      const result = await Task.updateMany(
        { reminderEndTime: { $exists: true, $ne: null } },
        { $unset: { reminderEndTime: '' }, $set: { lastReminderSent: null } }
      );
      if (result.modifiedCount > 0) {
        logger.info(`Cleared stale reminderEndTime from ${result.modifiedCount} tasks and reset their lastReminderSent`);
      }
    } catch (err) {
      logger.warn('Failed to clear stale reminderEndTime values:', err);
    }
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
    // Run every minute to support short custom intervals (e.g. every 1 minute)
    const task = cron.schedule('* * * * *', async () => {
      try {
        logger.info('Running task deadline reminder check...');
        await this.checkTaskDeadlines();
        await this.checkNoteReminders();
      } catch (error) {
        logger.error('Error in task deadline reminder cron job:', error);
      }
    });

    this.tasks.set('taskDeadlineReminders', task);
    logger.info('Task/note reminder cron job scheduled (runs every 15 minutes)');
  }

  /**
   * Check tasks and send reminders based on custom frequency settings
   */
  private async checkTaskDeadlines() {
    const now = new Date();

    try {
      // Find all non-completed tasks with a reminder frequency set (due date NOT required)
      const tasks = await Task.find({
        status: { $ne: 'completed' },
        reminderFrequency: { $exists: true, $nin: ['none', null] }
      })
        .populate('assignees', 'displayName email')
        .populate('assignedTo', 'displayName email')
        .populate('createdBy', 'displayName email')
        .populate('projectId', 'name')
        .lean();

      logger.info(`Found ${tasks.length} tasks to check for reminders`);

      for (const task of tasks) {
        const reminderFreq = task.reminderFrequency || '24hours';
        const lastReminder = task.lastReminderSent ? new Date(task.lastReminderSent) : null;

        // Resolve frequency in minutes
        let frequencyMinutes = 1440;
        switch (reminderFreq) {
          case '30minutes':   frequencyMinutes = 30;   break;
          case '1hour':       frequencyMinutes = 60;   break;
          case '3hours':      frequencyMinutes = 180;  break;
          case '12hours':     frequencyMinutes = 720;  break;
          case '24hours':     frequencyMinutes = 1440; break;
          case '48hours':     frequencyMinutes = 2880; break;
          case 'custom':
            frequencyMinutes = Number((task as any).customReminderMinutes) > 0
              ? Number((task as any).customReminderMinutes)
              : 1440;
            break;
        }

        // Determine whether it is time to send
        let shouldSend = false;
        if (lastReminder) {
          const minutesSinceLastReminder = Math.floor((now.getTime() - lastReminder.getTime()) / (1000 * 60));
          if (minutesSinceLastReminder >= frequencyMinutes) {
            shouldSend = true;
          } else {
            logger.info(`Skipping "${task.title}" — only ${minutesSinceLastReminder}/${frequencyMinutes} min since last reminder`);
          }
        } else {
          // First reminder ever — fire immediately (unless task has a due date that is >24h overdue)
          if (task.dueDate) {
            const minutesUntilDue = Math.floor((new Date(task.dueDate).getTime() - now.getTime()) / (1000 * 60));
            shouldSend = minutesUntilDue > -1440; // don't spam for very old overdue tasks
          } else {
            shouldSend = true; // no due date — fire on first cron hit inside the time window
          }
        }

        if (!shouldSend) continue;

        // Check reminderStartTime — only block if we haven't passed start time today
        // Ignore reminderEndTime (removed from UI; old DB values should not block indefinitely)
        if (task.reminderStartTime) {
          const nowMins = now.getHours() * 60 + now.getMinutes();
          const [sh, sm] = (task.reminderStartTime as string).split(':').map(Number);
          const startMins = sh * 60 + sm;

          if (nowMins < startMins) {
            // Before start time today — skip but don't consume the frequency slot
            // (don't set lastReminderSent so it will fire once start time is reached)
            logger.info(`Skipping "${task.title}" — ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')} is before start time ${task.reminderStartTime}`);
            continue;
          }
        }

        // Collect assignee emails and user IDs (assignees + createdBy)
        const recipients: string[] = [];
        const assigneeUserIds: string[] = [];

        if (task.assignees && Array.isArray(task.assignees)) {
          task.assignees.forEach((assignee: any) => {
            if (assignee && assignee.email) recipients.push(assignee.email);
            if (assignee && assignee._id) assigneeUserIds.push(assignee._id.toString());
          });
        }

        if (task.assignedTo && typeof task.assignedTo === 'object') {
          const at = task.assignedTo as any;
          if (at.email && !recipients.includes(at.email)) recipients.push(at.email);
          if (at._id) {
            const uid = at._id.toString();
            if (!assigneeUserIds.includes(uid)) assigneeUserIds.push(uid);
          }
        }

        // Always include the task creator so solo tasks (no assignees) still get reminders
        if (task.createdBy && typeof task.createdBy === 'object') {
          const cb = task.createdBy as any;
          if (cb.email && !recipients.includes(cb.email)) recipients.push(cb.email);
          if (cb._id) {
            const uid = cb._id.toString();
            if (!assigneeUserIds.includes(uid)) assigneeUserIds.push(uid);
          }
        }

        if (recipients.length === 0 && assigneeUserIds.length === 0) {
          logger.warn(`Task ${task._id} has no recipients to notify`);
          continue;
        }

        const projectName = typeof task.projectId === 'object' && (task.projectId as any).name
          ? (task.projectId as any).name
          : 'Unknown Project';

        const projectId = typeof task.projectId === 'object' && (task.projectId as any)._id
          ? (task.projectId as any)._id.toString()
          : task.projectId.toString();

        // Human-readable time until due (graceful when no due date)
        const dueDateObj: Date | null = task.dueDate ? new Date(task.dueDate) : null;
        let dueLabel: string;
        if (!dueDateObj) {
          dueLabel = 'no due date';
        } else {
          const minutesUntilDue = Math.floor((dueDateObj.getTime() - now.getTime()) / (1000 * 60));
          const absMinutes = Math.abs(minutesUntilDue);
          if (minutesUntilDue < 0) {
            dueLabel = `overdue by ${absMinutes < 60 ? `${absMinutes}m` : `${Math.round(absMinutes / 60)}h`}`;
          } else if (minutesUntilDue < 60) {
            dueLabel = `due in ${minutesUntilDue}m`;
          } else if (minutesUntilDue < 1440) {
            dueLabel = `due in ${Math.round(minutesUntilDue / 60)}h`;
          } else {
            dueLabel = `due in ${Math.round(minutesUntilDue / 1440)}d`;
          }
        }

        // Send in-app + push notification to each assignee
        for (const uid of assigneeUserIds) {
          try {
            await createNotification({
              userId: uid,
              type: 'task_deadline_reminder',
              title: `Task Reminder: ${task.title}`,
              message: `"${task.title}" — ${dueLabel} (${projectName})`,
              metadata: {
                taskId: task._id as any,
                taskTitle: task.title,
                projectId,
                projectName,
              }
            });
          } catch (notifErr) {
            logger.warn(`Failed to create in-app notification for user ${uid}:`, notifErr);
          }
        }

        // Send reminder email
        let emailSent = false;
        if (recipients.length > 0) {
          emailSent = await emailService.sendTaskDeadlineReminder(recipients, {
            taskTitle: task.title,
            taskId: task._id.toString(),
            projectName,
            projectId,
            dueDate: dueDateObj,  // null if no due date — email handles it gracefully
            priority: task.priority
          });

          if (emailSent) {
            logger.info(`Sent deadline reminder email for task "${task.title}" to ${recipients.join(', ')}`);
          } else {
            logger.warn(`Failed to send reminder email for task "${task.title}" to ${recipients.join(', ')}`);
          }
        }

        // Update lastReminderSent if either channel delivered
        if (assigneeUserIds.length > 0 || emailSent) {
          await Task.findByIdAndUpdate(task._id, { lastReminderSent: new Date() });
        }
      }
    } catch (error) {
      logger.error('Error checking task deadlines:', error);
    }
  }

  /**
   * Check notes and create in-app/push reminders based on configured frequency.
   */
  private async checkNoteReminders() {
    const now = new Date();

    try {
      const notes = await Note.find({
        reminderDate: { $exists: true, $ne: null },
        reminderFrequency: { $ne: 'none' }
      }).lean();

      for (const note of notes) {
        const reminderDate = new Date(note.reminderDate!);
        const reminderFreq = note.reminderFrequency || 'none';
        if (reminderFreq === 'none') continue;

        let frequencyMinutes = 1440;
        switch (reminderFreq) {
          case '30minutes':
            frequencyMinutes = 30;
            break;
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
          case 'custom':
            frequencyMinutes = Number(note.customReminderMinutes) > 0
              ? Number(note.customReminderMinutes)
              : 1440;
            break;
        }

        let shouldSend = false;
        if (note.lastReminderSent) {
          const lastReminder = new Date(note.lastReminderSent);
          const minutesSinceLastReminder = Math.floor((now.getTime() - lastReminder.getTime()) / (1000 * 60));
          shouldSend = minutesSinceLastReminder >= frequencyMinutes;
        } else {
          const minutesUntilReminder = Math.floor((reminderDate.getTime() - now.getTime()) / (1000 * 60));
          shouldSend = minutesUntilReminder <= frequencyMinutes;
        }

        if (!shouldSend) continue;

        await createNotification({
          userId: note.userId,
          type: 'note_reminder',
          title: 'Note Reminder',
          message: `Reminder for note "${note.title}"`,
          metadata: {
            noteId: note._id as any,
            noteTitle: note.title
          }
        });

        await Note.findByIdAndUpdate(note._id, {
          lastReminderSent: new Date()
        });
      }
    } catch (error) {
      logger.error('Error checking note reminders:', error);
    }
  }

  /**
   * Manually trigger task deadline check (for testing)
   */
  async manualCheckDeadlines() {
    logger.info('Manually triggering task deadline check...');
    await this.checkTaskDeadlines();
    await this.checkNoteReminders();
  }
}

// Export singleton instance
export const cronService = new CronService();
