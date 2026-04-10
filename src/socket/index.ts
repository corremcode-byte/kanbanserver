import { Server as SocketIOServer } from 'socket.io';
import { socketAuth } from './socketAuth';
import { setupSocketHandlers } from './socketHandlers';
import { logger } from '../utils/logger';

let ioInstance: SocketIOServer | null = null;

export const initializeSocket = (io: SocketIOServer) => {
  // Store the IO instance
  ioInstance = io;

  // Log Socket.IO initialization
  logger.info('🚀 Initializing Socket.IO server...');

  // Authentication middleware
  io.use(socketAuth);

  // Setup socket handlers
  setupSocketHandlers(io);

  // Handle server-side errors
  io.engine.on('connection_error', (error) => {
    logger.error('❌ Socket.IO connection error:', error);
  });

  // Log when engine is ready
  io.engine.on('initial_headers', () => {
    logger.info('Socket.IO engine ready for connections');
  });

  logger.info('✅ Socket.IO initialized successfully - Ready to accept frontend connections');
};

/**
 * Get the Socket.IO instance, or null if not yet initialized.
 * Callers must guard: `const io = getIO(); if (!io) return;`
 */
export const getIO = (): SocketIOServer | null => {
  return ioInstance;
};    