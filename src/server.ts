// Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
dotenv.config();

import dns from 'dns';
// Node's c-ares resolver can fall back to 127.0.0.1 on Windows even when the
// OS network adapter is correctly configured, breaking SRV lookups for
// mongodb+srv:// URIs. Force known-good public resolvers before connecting.
dns.setServers(['8.8.8.8', '8.8.4.4']);

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
//import { createClient } from 'ioredis';
import Redis from 'ioredis';
import cors from 'cors';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { initializeSocket } from './socket';
import { attachGuacTunnelProxy } from './socket/guacTunnelProxy';
import routes from './routes';
import { errorHandler } from './middleware';
import { logger } from './utils/logger';
import { cronService } from './services/cronService';

// Create Express app
const app = express();
const server = createServer(app);

const defaultAllowedOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envAllowedOrigins]));

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
  }
});

// Setup Redis adapter for Socket.IO cluster support (only if REDIS_URL is configured)
const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  const pubClient = new Redis(redisUrl);
  const subClient = pubClient.duplicate();
  pubClient.on('error', (err: Error) => logger.warn('Redis pub error:', err.message));
  subClient.on('error', (err: Error) => logger.warn('Redis sub error:', err.message));
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('✅ Redis adapter connected for Socket.IO');
} else {
  logger.info('ℹ️  Redis not configured — using in-memory adapter (single-server mode)');
}

// Initialize socket handlers
initializeSocket(io);

// Proxies the Remote Server Workspace's Guacamole tunnel over its own upgrade
// path — separate from Socket.IO's own upgrade listener, so both coexist on
// the same HTTP server without conflict.
attachGuacTunnelProxy(server);

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600
}));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from uploads directory with no-cache headers
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  // Tell browsers to display the file inline instead of downloading it
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}, express.static(path.join(__dirname, '../uploads')));

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
    await cronService.start();

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
