import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { initializeSocket } from './socket';
import routes from './routes';
import { errorHandler } from './middleware';
import { logger } from './utils/logger';
import { cronService } from './services/cronService';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const server = createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
  }
});

// Initialize socket handlers
initializeSocket(io);

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600
}));
app.use(helmet());
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api', routes);

// Error handler
app.use(errorHandler);

// Connect to MongoDB
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/asana-clone';
    await mongoose.connect(mongoURI);
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.error('MongoDB connection failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

// Start server
const PORT = process.env.PORT || 4001;

const startServer = async () => {
  try {
    await connectDB();

    // Start cron jobs
    cronService.start();

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
      logger.info(`API endpoint: http://localhost:${PORT}/api`);
      logger.info(`Socket.IO enabled: ws://localhost:${PORT}`);
      logger.info(`Cron jobs started`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  cronService.stop();
  server.close(async () => {
    logger.info('HTTP server closed');
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received: closing HTTP server');
  cronService.stop();
  server.close(async () => {
    logger.info('HTTP server closed');
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
    process.exit(0);
  });
});

startServer();

// Export for testing
export { app, io };
