import dns from 'dns';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

// Node's c-ares resolver can fall back to 127.0.0.1 on Windows even when the
// OS network adapter is correctly configured, breaking SRV lookups for
// mongodb+srv:// URIs. Force known-good public resolvers before connecting.
dns.setServers(['8.8.8.8', '8.8.4.4']);

const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    
    if (!mongoURI) {
      // Don't throw error - allow server to start without MongoDB (for MySQL migration)
      console.warn('⚠️  MONGODB_URI not set - MongoDB connection skipped (MySQL migration needed)');
      return;
    }

    const options = {
      // Connection options
      maxPoolSize: 50, // Maintain up to 50 socket connections
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      family: 4, // Use IPv4, skip trying IPv6
      
      // Additional options for production
      retryWrites: true,
      
      // Index creation
      autoIndex: process.env.NODE_ENV === 'development',
    };

    // Connect to MongoDB
    await mongoose.connect(mongoURI, options);

    logger.info('🚀 MongoDB connected successfully');

    // Drop stale firebaseUid index if it exists (legacy from Firebase migration)
    try {
      const usersCollection = mongoose.connection.collection('users');
      const indexes = await usersCollection.indexes();
      
      // Check for firebaseUid index by name or by key pattern (including compound indexes)
      const firebaseUidIndexes = indexes.filter(idx => 
        idx.name === 'firebaseUid_1' || 
        idx.name?.includes('firebaseUid') ||
        (idx.key && 'firebaseUid' in idx.key)
      );
      
      if (firebaseUidIndexes.length > 0) {
        // Drop all firebaseUid-related indexes
        for (const firebaseUidIndex of firebaseUidIndexes) {
          try {
            // Try dropping by name first
            await usersCollection.dropIndex(firebaseUidIndex.name!);
            logger.info(`🧹 Dropped stale firebaseUid index (${firebaseUidIndex.name}) from users collection`);
          } catch (dropError: any) {
            if (dropError.code !== 27) { // 27 = IndexNotFound
              logger.error(`Failed to drop firebaseUid index ${firebaseUidIndex.name}: ${dropError.message}`);
              logger.warn(`⚠️  firebaseUid index ${firebaseUidIndex.name} still exists. Run the dropFirebaseIndex script to remove it manually.`);
            }
          }
        }
      } else {
        logger.debug('No firebaseUid index found - already removed or never existed');
      }
    } catch (indexError: any) {
      // Index check might fail, log but don't crash
      logger.warn(`Error checking/dropping firebaseUid index: ${indexError.message}`);
      logger.warn('⚠️  If you encounter E11000 duplicate key errors for firebaseUid, run the dropFirebaseIndex script');
    }

    // Handle connection events
    mongoose.connection.on('error', (error) => {
      logger.error('MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed due to application termination');
        process.exit(0);
      } catch (error) {
        logger.error('Error during database disconnection:', error);
        process.exit(1);
      }
    });

  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
};

// Function to check database health
export const checkDatabaseHealth = async (): Promise<boolean> => {
  try {
    const state = mongoose.connection.readyState;
    return state === 1; // 1 = connected
  } catch (error) {
    logger.error('Database health check failed:', error);
    return false;
  }
};

// Function to get database stats
export const getDatabaseStats = async () => {
  try {
    const stats = await mongoose.connection.db.stats();
    return {
      database: mongoose.connection.name,
      collections: stats.collections,
      documents: stats.objects,
      storageSize: stats.storageSize,
      indexSize: stats.indexSize,
      dataSize: stats.dataSize
    };
  } catch (error) {
    logger.error('Failed to get database stats:', error);
    return null;
  }
};

export default connectDB;
