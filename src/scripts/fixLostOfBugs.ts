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

// Fix the "Lost of bugs" task
const fixTask = async () => {
  try {
    const Task = mongoose.connection.collection('tasks');

    // Find the task
    const task = await Task.findOne({ title: 'Lost of bugs' });

    if (!task) {
      console.log('❌ Task "Lost of bugs" not found');
      return;
    }

    console.log('\n📋 Found task:');
    console.log(`  Title: ${task.title}`);
    console.log(`  Current status: ${task.status}`);
    console.log(`  Current listId: ${task.listId}`);

    // Update to sync status and listId
    await Task.updateOne(
      { _id: task._id },
      {
        $set: {
          status: 'in-progress',
          listId: 'in-progress'
        }
      }
    );

    console.log('\n✅ Task updated:');
    console.log('  New status: in-progress');
    console.log('  New listId: in-progress');

  } catch (error) {
    console.error('❌ Error fixing task:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  console.log('🚀 Fixing "Lost of bugs" task...\n');

  await connectDB();
  await fixTask();

  await mongoose.disconnect();
  console.log('\n👋 Disconnected from MongoDB');
  process.exit(0);
};

// Run the script
main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
