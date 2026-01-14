import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function dropFirebaseIndex() {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      console.error('MONGODB_URI not set');
      process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoURI);
    console.log('Connected!');

    const usersCollection = mongoose.connection.collection('users');

    // List all indexes
    const indexes = await usersCollection.indexes();
    console.log('\nCurrent indexes on users collection:');
    indexes.forEach(idx => {
      console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });

    // Drop all firebaseUid-related indexes (including compound indexes)
    const firebaseUidIndexes = indexes.filter(idx => 
      idx.name === 'firebaseUid_1' || 
      idx.name?.includes('firebaseUid') ||
      (idx.key && 'firebaseUid' in idx.key)
    );
    
    if (firebaseUidIndexes.length > 0) {
      for (const idx of firebaseUidIndexes) {
        try {
          await usersCollection.dropIndex(idx.name!);
          console.log(`\n✅ Dropped ${idx.name} index`);
        } catch (error: any) {
          console.error(`\n❌ Failed to drop ${idx.name}: ${error.message}`);
        }
      }
    } else {
      console.log('\n✅ No firebaseUid indexes found');
    }

    // List indexes after
    const indexesAfter = await usersCollection.indexes();
    console.log('\nIndexes after cleanup:');
    indexesAfter.forEach(idx => {
      console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });

    await mongoose.connection.close();
    console.log('\nDone!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

dropFirebaseIndex();
