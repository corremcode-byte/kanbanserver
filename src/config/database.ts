import mongoose from 'mongoose';
import { logger } from '../utils/logger';

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
      maxPoolSize: 10, // Maintain up to 10 socket connections
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
