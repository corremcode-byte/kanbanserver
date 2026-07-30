import mongoose from 'mongoose';
import Task from '../models/Task';
import dotenv from 'dotenv';

dotenv.config();

async function checkTasks() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || '');
    console.log('Connected to MongoDB\n');

    const tasks = await Task.find({
      dueDate: { $exists: true, $ne: null }
    })
      .select('title dueDate reminderFrequency lastReminderSent assignees assignedTo status')
      .lean();

    console.log('Total tasks with due dates:', tasks.length);
    console.log('\n=== Tasks Details ===');

    tasks.forEach((task: any) => {
      console.log('\n-----------------------------------');
      console.log('Title:', task.title);
      console.log('Status:', task.status);
      console.log('Due Date:', task.dueDate);
      console.log('Reminder Frequency:', task.reminderFrequency || 'Not set');
      console.log('Last Reminder Sent:', task.lastReminderSent || 'Never');

      console.log('Assignees count:', task.assignees?.length || 0);
      console.log('Has assignedTo:', task.assignedTo ? 'Yes' : 'No');

      // Calculate time until due
      const now = new Date();
      const dueDate = new Date(task.dueDate);
      const minutesUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60));

      if (minutesUntilDue < 0) {
        console.log('⚠️  OVERDUE by', Math.abs(minutesUntilDue), 'minutes');
      } else {
        const days = Math.floor(minutesUntilDue / (24 * 60));
        const hours = Math.floor((minutesUntilDue % (24 * 60)) / 60);
        const mins = minutesUntilDue % 60;
        console.log('⏰ Due in:', days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`);
      }
    });

    await mongoose.connection.close();
    console.log('\n\nDatabase connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkTasks();
