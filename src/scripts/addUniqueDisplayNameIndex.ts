import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

const addUniqueDisplayNameIndex = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kanban';
    logger.info(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    logger.info('Connected to MongoDB');

    // First, find and fix any duplicate displayNames
    const users = await User.find({});
    const displayNameCounts = new Map<string, number>();

    // Count occurrences of each displayName
    for (const user of users) {
      const count = displayNameCounts.get(user.displayName) || 0;
      displayNameCounts.set(user.displayName, count + 1);
    }

    // Find duplicates
    const duplicates = Array.from(displayNameCounts.entries())
      .filter(([_, count]) => count > 1)
      .map(([name, _]) => name);

    if (duplicates.length > 0) {
      logger.info(`Found ${duplicates.length} duplicate displayNames. Fixing...`);

      for (const duplicateName of duplicates) {
        const duplicateUsers = await User.find({ displayName: duplicateName }).sort({ createdAt: 1 });

        // Keep the first user's name, rename the rest
        for (let i = 1; i < duplicateUsers.length; i++) {
          const newDisplayName = `${duplicateName}_${i}`;
          logger.info(`Renaming user ${duplicateUsers[i].email} from "${duplicateName}" to "${newDisplayName}"`);

          duplicateUsers[i].displayName = newDisplayName;
          await duplicateUsers[i].save();
        }
      }

      logger.info('All duplicate displayNames have been fixed');
    } else {
      logger.info('No duplicate displayNames found');
    }

    // Drop existing index if it exists (without unique constraint)
    try {
      await User.collection.dropIndex('displayName_1');
      logger.info('Dropped old displayName index');
    } catch (error) {
      logger.info('No existing displayName index to drop');
    }

    // Create unique index on displayName
    await User.collection.createIndex({ displayName: 1 }, { unique: true });
    logger.info('Created unique index on displayName field');

    // Verify the index was created
    const indexes = await User.collection.indexes();
    const displayNameIndex = indexes.find(idx => idx.key && idx.key.displayName === 1);

    if (displayNameIndex && displayNameIndex.unique) {
      logger.info('✅ Unique index on displayName verified successfully');
    } else {
      logger.warn('⚠️ Unique index may not have been created correctly');
    }

    await mongoose.disconnect();
    logger.info('Migration completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Run the migration
addUniqueDisplayNameIndex();
