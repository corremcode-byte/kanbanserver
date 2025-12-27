import { Server as SocketIOServer } from 'socket.io';
import { AuthenticatedSocket, getSocketUserId, canJoinRoom } from './socketAuth';
import { logger } from '../utils/logger';

// Store active connections
const activeConnections = new Map<string, Set<string>>(); // userId -> Set of socketIds
const socketRooms = new Map<string, Set<string>>(); // socketId -> Set of rooms

// Helper to track user connections
const addUserConnection = (userId: string, socketId: string) => {
  if (!activeConnections.has(userId)) {
    activeConnections.set(userId, new Set());
  }
  activeConnections.get(userId)!.add(socketId);
};

const removeUserConnection = (userId: string, socketId: string) => {
  const userSockets = activeConnections.get(userId);
  if (userSockets) {
    userSockets.delete(socketId);
    if (userSockets.size === 0) {
      activeConnections.delete(userId);
    }
  }
};

const addSocketRoom = (socketId: string, room: string) => {
  if (!socketRooms.has(socketId)) {
    socketRooms.set(socketId, new Set());
  }
  socketRooms.get(socketId)!.add(room);
};

const removeSocketRoom = (socketId: string, room: string) => {
  const rooms = socketRooms.get(socketId);
  if (rooms) {
    rooms.delete(room);
  }
};

const cleanupSocket = (socketId: string) => {
  socketRooms.delete(socketId);
};

// Socket event handlers
export const setupSocketHandlers = (io: SocketIOServer) => {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = getSocketUserId(socket);

    if (!userId) {
      logger.error('Socket connected without user ID');
      socket.disconnect();
      return;
    }

    // Log detailed connection info
    const connectionInfo = {
      socketId: socket.id,
      userId,
      userName: socket.user?.name || 'Unknown',
      userEmail: socket.user?.email || 'Unknown',
      timestamp: new Date().toISOString(),
      clientAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'] || 'Unknown'
    };

    logger.info('✅ Frontend connected:', connectionInfo);

    // Track user connection
    addUserConnection(userId, socket.id);

    // Auto-join user's personal room for notifications
    const userRoom = `user:${userId}`;
    socket.join(userRoom);
    addSocketRoom(socket.id, userRoom);

    logger.info(`User ${socket.user?.name || userId} joined room: ${userRoom}`);
    
    // Handle project room management
    socket.on('join:project', async (projectId: string) => {
      try {
        if (!projectId || typeof projectId !== 'string') {
          socket.emit('error', { message: 'Invalid project ID' });
          return;
        }

        const canJoin = await canJoinRoom(socket, 'project', projectId);
        if (!canJoin) {
          socket.emit('error', { message: 'Access denied to project' });
          return;
        }

        const room = `project:${projectId}`;
        socket.join(room);
        addSocketRoom(socket.id, room);

        socket.emit('joined:project', { projectId });
        logger.info(`✅ User ${socket.user?.name || userId} (${socket.id}) joined project room: ${room}`);
      } catch (error) {
        logger.error('Error joining project room:', error);
        socket.emit('error', { message: 'Failed to join project' });
      }
    });

    socket.on('leave:project', (projectId: string) => {
      try {
        if (!projectId || typeof projectId !== 'string') {
          socket.emit('error', { message: 'Invalid project ID' });
          return;
        }

        const room = `project:${projectId}`;
        socket.leave(room);
        removeSocketRoom(socket.id, room);

        socket.emit('left:project', { projectId });
        logger.info(`User ${socket.user?.name || userId} (${socket.id}) left project room: ${room}`);
      } catch (error) {
        logger.error('Error leaving project room:', error);
      }
    });

    // Handle task events
    socket.on('task:update', (data: { projectId: string; taskId: string; task: any }) => {
      try {
        const { projectId, taskId, task } = data;
        
        if (!projectId || !taskId || !task) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('task:updated', {
          taskId,
          task,
          updatedBy: userId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling task update:', error);
      }
    });

    socket.on('task:create', (data: { projectId: string; task: any }) => {
      try {
        const { projectId, task } = data;
        
        if (!projectId || !task) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('task:created', {
          task,
          createdBy: userId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling task creation:', error);
      }
    });

    socket.on('task:delete', (data: { projectId: string; taskId: string }) => {
      try {
        const { projectId, taskId } = data;
        
        if (!projectId || !taskId) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('task:deleted', {
          taskId,
          deletedBy: userId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling task deletion:', error);
      }
    });

    socket.on('tasks:reorder', (data: { projectId: string; tasks: any[] }) => {
      try {
        const { projectId, tasks } = data;
        
        if (!projectId || !tasks) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('tasks:reordered', {
          projectId,
          tasks,
          reorderedBy: userId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling tasks reordering:', error);
      }
    });

    // Handle typing indicators
    socket.on('typing:start', (data: { projectId: string; taskId?: string }) => {
      try {
        const { projectId, taskId } = data;
        
        if (!projectId) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('typing:start', {
          userId,
          user: {
            id: socket.user._id,
            name: socket.user.name,
            avatar: socket.user.avatar
          },
          projectId,
          taskId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling typing start:', error);
      }
    });

    socket.on('typing:stop', (data: { projectId: string; taskId?: string }) => {
      try {
        const { projectId, taskId } = data;
        
        if (!projectId) {
          return;
        }

        const room = `project:${projectId}`;
        socket.to(room).emit('typing:stop', {
          userId,
          projectId,
          taskId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling typing stop:', error);
      }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      const disconnectionInfo = {
        socketId: socket.id,
        userId,
        userName: socket.user?.name || 'Unknown',
        reason,
        timestamp: new Date().toISOString()
      };

      logger.info('❌ Frontend disconnected:', disconnectionInfo);

      // Clean up tracking
      removeUserConnection(userId, socket.id);
      cleanupSocket(socket.id);

      // Broadcast offline status to rooms
      const rooms = socketRooms.get(socket.id) || new Set();
      rooms.forEach(room => {
        socket.to(room).emit('user:offline', {
          userId,
          timestamp: new Date()
        });
      });

      // Log connection summary
      const remainingConnections = activeConnections.get(userId)?.size || 0;
      logger.info(`User ${socket.user?.name || userId} has ${remainingConnections} remaining connection(s)`);
    });

    // Send initial connection confirmation
    socket.emit('connected', { 
      socketId: socket.id,
      userId,
      timestamp: new Date()
    });
  });
};

// Helper functions for external use
export const getActiveUserConnections = (userId: string): string[] => {
  return Array.from(activeConnections.get(userId) || []);
};

export const getUserPresence = (userId: string): boolean => {
  return activeConnections.has(userId) && activeConnections.get(userId)!.size > 0;
};

export const broadcastToUser = (io: SocketIOServer, userId: string, event: string, data: any) => {
  io.to(`user:${userId}`).emit(event, data);
};

export const broadcastToProject = (io: SocketIOServer, projectId: string, event: string, data: any) => {
  io.to(`project:${projectId}`).emit(event, data);
};

export default {
  setupSocketHandlers,
  getActiveUserConnections,
  getUserPresence,
  broadcastToUser,
  broadcastToProject
};
