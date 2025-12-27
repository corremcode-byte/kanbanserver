import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Connect to MongoDB
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      throw new Error('MONGODB_URI not found in environment variables');
    }
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Normalize status values
const normalizeStatus = (status: string): string => {
  const normalized = status.toLowerCase().trim();
  if (normalized === 'in_progress') return 'in-progress';
  if (normalized === 'done') return 'completed';
  return status;
};

// Fix all tasks
const fixAllTasks = async () => {
  try {
    const Task = mongoose.connection.collection('tasks');

    // Get all tasks
    const tasks = await Task.find({}).toArray();
    console.log(`\n📊 Found ${tasks.length} tasks to check`);

    let updatedCount = 0;
    let alreadyCorrectCount = 0;

    for (const task of tasks) {
      const currentStatus = task.status || 'todo';
      const currentListId = task.listId || task.status || 'todo';

      // Normalize both values
      const normalizedStatus = normalizeStatus(currentStatus);
      const normalizedListId = normalizeStatus(currentListId);

      // Check if they need updating
      const needsUpdate =
        task.status !== normalizedStatus ||
        task.listId !== normalizedListId ||
        task.status !== task.listId;

      if (needsUpdate) {
        console.log(`\n🔧 Fixing task: "${task.title}"`);
        console.log(`   Before: status="${task.status}", listId="${task.listId}"`);

        // Update the task to have matching, normalized status and listId
        await Task.updateOne(
          { _id: task._id },
          {
            $set: {
              status: normalizedStatus,
              listId: normalizedStatus
            }
          }
        );

        console.log(`   After:  status="${normalizedStatus}", listId="${normalizedStatus}"`);
        updatedCount++;
      } else {
        alreadyCorrectCount++;
      }
    }

    console.log(`\n✨ Migration complete!`);
    console.log(`   ✅ Updated: ${updatedCount} tasks`);
    console.log(`   ✓  Already correct: ${alreadyCorrectCount} tasks`);
    console.log(`   📊 Total: ${tasks.length} tasks\n`);

  } catch (error) {
    console.error('❌ Error fixing tasks:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Starting task listId migration...\n');

  await connectDB();
  await fixAllTasks();

  await mongoose.disconnect();
  console.log('👋 Disconnected from MongoDB');
  process.exit(0);
};

// Run the script
main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
