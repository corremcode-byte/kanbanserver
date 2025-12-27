import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Task } from '../models';

dotenv.config();

const migrateCompletedTasks = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/asana-clone');
    console.log('Connected successfully!');

    // Find all tasks with status "done" or "completed" but no completedAt
    const tasksToUpdate = await Task.find({
      $or: [
        { status: 'done' },
        { status: 'completed' }
      ],
      completedAt: { $exists: false }
    });

    console.log(`Found ${tasksToUpdate.length} completed tasks without completedAt timestamp`);

    // Update each task
    for (const task of tasksToUpdate) {
      // Use updatedAt as completedAt if it exists, otherwise use createdAt
      const completedAt = task.updatedAt || task.createdAt;

      await Task.findByIdAndUpdate(task._id, {
        completedAt: completedAt
      });

      console.log(`✓ Updated task: ${task.title} (completedAt: ${completedAt})`);
    }

    // Also set assignedAt for tasks that don't have it but have assignees
    const tasksWithoutAssignedAt = await Task.find({
      assignees: { $exists: true, $ne: [] },
      assignedAt: { $exists: false }
    });

    console.log(`\nFound ${tasksWithoutAssignedAt.length} tasks with assignees but no assignedAt`);

    for (const task of tasksWithoutAssignedAt) {
      // Use createdAt as assignedAt
      await Task.findByIdAndUpdate(task._id, {
        assignedAt: task.createdAt
      });

      console.log(`✓ Set assignedAt for task: ${task.title}`);
    }

    console.log('\n✅ Migration completed successfully!');
    console.log(`Total tasks updated: ${tasksToUpdate.length + tasksWithoutAssignedAt.length}`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

migrateCompletedTasks();
