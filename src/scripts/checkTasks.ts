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

// Check all tasks
const checkTasks = async () => {
  try {
    const Task = mongoose.connection.collection('tasks');

    // Get all tasks
    const tasks = await Task.find({}).toArray();
    console.log(`\n📊 Found ${tasks.length} tasks\n`);

    tasks.forEach((task: any) => {
      console.log(`Task: "${task.title}"`);
      console.log(`  status: ${task.status}`);
      console.log(`  listId: ${task.listId}`);
      console.log(`  createdAt: ${task.createdAt}`);
      console.log(`  updatedAt: ${task.updatedAt}`);
      console.log('---');
    });

  } catch (error) {
    console.error('❌ Error checking tasks:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Checking tasks...\n');

  await connectDB();
  await checkTasks();

  await mongoose.disconnect();
  console.log('\n👋 Disconnected from MongoDB');
  process.exit(0);
};

// Run the script
main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
