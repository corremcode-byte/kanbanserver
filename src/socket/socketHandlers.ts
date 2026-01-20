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

    // Handle chat room management
    socket.on('join:chat', async (groupId: string) => {
      try {
        if (!groupId || typeof groupId !== 'string') {
          socket.emit('error', { message: 'Invalid group ID' });
          return;
        }

        const room = `chat:${groupId}`;
        socket.join(room);
        addSocketRoom(socket.id, room);

        socket.emit('joined:chat', { groupId });
        logger.info(`✅ User ${socket.user?.name || userId} (${socket.id}) joined chat room: ${room}`);
      } catch (error) {
        logger.error('Error joining chat room:', error);
        socket.emit('error', { message: 'Failed to join chat' });
      }
    });

    socket.on('leave:chat', (groupId: string) => {
      try {
        if (!groupId || typeof groupId !== 'string') {
          socket.emit('error', { message: 'Invalid group ID' });
          return;
        }

        const room = `chat:${groupId}`;
        socket.leave(room);
        removeSocketRoom(socket.id, room);

        socket.emit('left:chat', { groupId });
        logger.info(`User ${socket.user?.name || userId} (${socket.id}) left chat room: ${room}`);
      } catch (error) {
        logger.error('Error leaving chat room:', error);
      }
    });

    // Handle chat typing indicators
    socket.on('chat:typing:start', (data: { groupId: string }) => {
      try {
        const { groupId } = data;

        if (!groupId) {
          return;
        }

        const room = `chat:${groupId}`;
        socket.to(room).emit('chat:typing:start', {
          userId,
          user: {
            id: socket.user._id,
            name: socket.user.name,
            avatar: socket.user.avatar
          },
          groupId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling chat typing start:', error);
      }
    });

    socket.on('chat:typing:stop', (data: { groupId: string }) => {
      try {
        const { groupId } = data;

        if (!groupId) {
          return;
        }

        const room = `chat:${groupId}`;
        socket.to(room).emit('chat:typing:stop', {
          userId,
          groupId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling chat typing stop:', error);
      }
    });

    // ==================== VIDEO/VOICE CALL HANDLERS ====================

    // Store active calls - Map<callId, callData>
    const activeCalls = new Map<string, {
      callId: string;
      callType: 'video' | 'voice';
      callerId: string;
      callerName: string;
      callerPhotoURL?: string;
      receiverId: string;
      receiverName?: string;
      groupId: string;
      groupName?: string;
      status: 'calling' | 'ringing' | 'connected' | 'ended';
      startedAt: Date;
    }>();

    // Initiate a call
    socket.on('call:initiate', (data: {
      callId: string;
      callType: 'video' | 'voice';
      receiverId: string;
      receiverName?: string;
      groupId: string;
      groupName?: string;
      callerName: string;
      callerPhotoURL?: string;
      offer: any; // WebRTC SDP offer
    }) => {
      try {
        const { callId, callType, receiverId, receiverName, groupId, groupName, callerName, callerPhotoURL, offer } = data;

        if (!callId || !receiverId || !groupId) {
          socket.emit('error', { message: 'Invalid call data' });
          return;
        }

        logger.info(`🔵 Call initiated: ${callId} from ${userId} to ${receiverId} (${callType}) in group ${groupId}`);

        // Store call data
        activeCalls.set(callId, {
          callId,
          callType,
          callerId: userId,
          callerName,
          callerPhotoURL,
          receiverId,
          receiverName,
          groupId,
          groupName,
          status: 'calling',
          startedAt: new Date()
        });

        const receiverRoom = `user:${receiverId}`;
        logger.info(`🔵 Emitting call:incoming to room: ${receiverRoom}`);

        // Send incoming call notification to receiver (including offer for peer connection setup)
        io.to(receiverRoom).emit('call:incoming', {
          callId,
          callType,
          callerId: userId,
          callerName,
          callerPhotoURL,
          receiverId,
          receiverName,
          groupId,
          groupName,
          status: 'ringing',
          startedAt: new Date(),
          offer // Include offer so receiver can setup peer connection immediately
        });

        logger.info(`🔵 Call notification with offer sent to ${receiverRoom}`);

      } catch (error) {
        logger.error('Error initiating call:', error);
        socket.emit('error', { message: 'Failed to initiate call' });
      }
    });

    // Accept a call
    socket.on('call:accept', (data: {
      callId: string;
      callerId: string;
      answer: any; // WebRTC SDP answer
    }) => {
      try {
        const { callId, callerId, answer } = data;

        if (!callId || !callerId) {
          socket.emit('error', { message: 'Invalid call accept data' });
          return;
        }

        logger.info(`Call accepted: ${callId} by ${userId}`);

        // Update call status
        const callData = activeCalls.get(callId);
        if (callData) {
          callData.status = 'connected';
        }

        // Send answer to caller
        io.to(`user:${callerId}`).emit('call:accepted', {
          callId,
          answer
        });

      } catch (error) {
        logger.error('Error accepting call:', error);
        socket.emit('error', { message: 'Failed to accept call' });
      }
    });

    // Reject a call
    socket.on('call:reject', (data: {
      callId: string;
      callerId: string;
      reason?: string;
    }) => {
      try {
        const { callId, callerId, reason } = data;

        if (!callId || !callerId) {
          socket.emit('error', { message: 'Invalid call reject data' });
          return;
        }

        logger.info(`Call rejected: ${callId} by ${userId}, reason: ${reason}`);

        // Remove call from active calls
        activeCalls.delete(callId);

        // Notify caller
        io.to(`user:${callerId}`).emit('call:rejected', {
          callId,
          reason: reason || 'Call rejected'
        });

      } catch (error) {
        logger.error('Error rejecting call:', error);
      }
    });

    // End a call
    socket.on('call:end', (data: {
      callId: string;
      receiverId: string;
      reason?: string;
    }) => {
      try {
        const { callId, receiverId, reason } = data;

        if (!callId || !receiverId) {
          socket.emit('error', { message: 'Invalid call end data' });
          return;
        }

        logger.info(`Call ended: ${callId} by ${userId}, reason: ${reason}`);

        // Remove call from active calls
        activeCalls.delete(callId);

        // Notify the other party
        io.to(`user:${receiverId}`).emit('call:ended', {
          callId,
          reason: reason || 'Call ended'
        });

      } catch (error) {
        logger.error('Error ending call:', error);
      }
    });

    // ICE candidate exchange
    socket.on('call:ice-candidate', (data: {
      callId: string;
      receiverId: string;
      candidate: any; // WebRTC ICE candidate
    }) => {
      try {
        const { callId, receiverId, candidate } = data;

        if (!callId || !receiverId || !candidate) {
          return;
        }

        // Forward ICE candidate to the other party
        io.to(`user:${receiverId}`).emit('call:ice-candidate', {
          callId,
          candidate
        });

      } catch (error) {
        logger.error('Error handling ICE candidate:', error);
      }
    });

    // User is busy (already in a call)
    socket.on('call:busy', (data: {
      callId: string;
      callerId: string;
    }) => {
      try {
        const { callId, callerId } = data;

        if (!callId || !callerId) {
          return;
        }

        logger.info(`User ${userId} is busy, rejecting call ${callId}`);

        // Remove call from active calls
        activeCalls.delete(callId);

        // Notify caller
        io.to(`user:${callerId}`).emit('call:busy', {
          callId
        });

      } catch (error) {
        logger.error('Error handling busy status:', error);
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
