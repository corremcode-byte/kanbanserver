import { Server as SocketIOServer } from 'socket.io';
import { AuthenticatedSocket, getSocketUserId, canJoinRoom } from './socketAuth';
import { logger } from '../utils/logger';
import { User } from '../models';
import { pushNotificationService } from '../services/pushNotificationService';

// Store active connections
const activeConnections = new Map<string, Set<string>>(); // userId -> Set of socketIds
const socketRooms = new Map<string, Set<string>>(); // socketId -> Set of rooms

// Store active group calls - MUST be outside connection handler to be shared across all connections
const activeGroupCalls = new Map<string, {
  callId: string;
  callType: 'video' | 'voice';
  groupId: string;
  groupName: string;
  initiatorId: string;
  initiatorName: string;
  initiatorPhotoURL?: string;
  participants: Map<string, { oderId: string; displayName: string; photoURL?: string }>;
  status: 'calling' | 'connected' | 'ended';
  startedAt: Date;
}>();

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

// Helper to check if user is online
const isUserOnline = (userId: string): boolean => {
  const userSockets = activeConnections.get(userId);
  return userSockets !== undefined && userSockets.size > 0;
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

        // If receiver is offline and it's a VOICE call, send push notification
        // (User requested this for voice calls only, not video calls)
        if (!isUserOnline(receiverId) && callType === 'voice') {
          logger.info(`📱 Receiver ${receiverId} is offline, sending push notification for voice call`);

          // Send push notification in background (don't await)
          pushNotificationService.sendToUser(receiverId, {
            title: `Incoming Voice Call`,
            body: `${callerName} is calling you`,
            icon: callerPhotoURL || '/kanban-icon.svg',
            badge: '/kanban-icon.svg',
            tag: `incoming-call-${callId}`,
            requireInteraction: true, // Keep notification visible until user interacts
            data: {
              type: 'incoming_voice_call',
              callId,
              callerId: userId,
              callerName,
              callerPhotoURL,
              groupId,
              groupName,
              url: '/' // Will be handled by service worker to open call UI
            }
          }).catch(error => {
            logger.error('Failed to send push notification for incoming call:', error);
          });
        }

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

    // ==================== GROUP VIDEO/VOICE CALL HANDLERS ====================

    // Initiate a group call
    socket.on('group-call:initiate', (data: {
      callId: string;
      callType: 'video' | 'voice';
      groupId: string;
      groupName: string;
      memberIds: string[];
      initiatorName: string;
      initiatorPhotoURL?: string;
    }) => {
      try {
        const { callId, callType, groupId, groupName, memberIds, initiatorName, initiatorPhotoURL } = data;

        if (!callId || !groupId || !memberIds || memberIds.length === 0) {
          socket.emit('error', { message: 'Invalid group call data' });
          return;
        }

        logger.info(`🔵 Group call initiated: ${callId} by ${userId} in group ${groupId} (${callType})`);
        logger.info(`🔵 Inviting members: ${memberIds.join(', ')}`);

        // Create participants map with initiator
        const participants = new Map<string, { oderId: string; displayName: string; photoURL?: string }>();
        participants.set(userId, {
          oderId: userId,
          displayName: initiatorName,
          photoURL: initiatorPhotoURL
        });

        // Store group call data
        activeGroupCalls.set(callId, {
          callId,
          callType,
          groupId,
          groupName,
          initiatorId: userId,
          initiatorName,
          initiatorPhotoURL,
          participants,
          status: 'calling',
          startedAt: new Date()
        });

        // Send incoming call notification to all group members
        memberIds.forEach(memberId => {
          const memberRoom = `user:${memberId}`;
          logger.info(`🔵 Sending group call notification to: ${memberRoom}`);

          io.to(memberRoom).emit('group-call:incoming', {
            callId,
            callType,
            groupId,
            groupName,
            initiatorId: userId,
            initiatorName,
            initiatorPhotoURL,
            participants: [userId] // List of users already in the call
          });
        });

        logger.info(`🔵 Group call notifications sent to ${memberIds.length} members`);

      } catch (error) {
        logger.error('Error initiating group call:', error);
        socket.emit('error', { message: 'Failed to initiate group call' });
      }
    });

    // Join a group call
    socket.on('group-call:join', async (data: {
      callId: string;
      displayName: string;
      photoURL?: string;
    }) => {
      try {
        const { callId } = data;

        if (!callId) {
          socket.emit('error', { message: 'Invalid call ID' });
          return;
        }

        const groupCall = activeGroupCalls.get(callId);
        if (!groupCall) {
          logger.warn(`❌ Group call not found: ${callId}. Active calls: ${Array.from(activeGroupCalls.keys()).join(', ') || 'none'}`);
          socket.emit('error', { message: 'Call not found' });
          return;
        }

        // Get user's actual displayName and photoURL from database
        let displayName = data.displayName || 'User';
        let photoURL = data.photoURL;
        
        try {
          const user = await User.findById(userId).select('displayName photoURL email');
          if (user) {
            displayName = user.displayName || user.email || displayName;
            photoURL = user.photoURL || photoURL;
          }
        } catch (error) {
          logger.warn(`Failed to fetch user info for ${userId}, using provided values:`, error);
        }

        logger.info(`👤 User ${userId} (${displayName}) joining group call ${callId}`);

        // Add user to participants with actual displayName from database
        groupCall.participants.set(userId, {
          oderId: userId,
          displayName,
          photoURL
        });

        // Update call status if this is the first person to join
        if (groupCall.status === 'calling') {
          groupCall.status = 'connected';
        }

        // Notify all other participants about the new joiner
        groupCall.participants.forEach((participant, participantId) => {
          if (participantId !== userId) {
            io.to(`user:${participantId}`).emit('group-call:user-joined', {
              callId,
              userId: userId,
              displayName,
              photoURL
            });
          }
        });

        // Send the current participant list to the new joiner
        const participantList: { oderId: string; displayName: string; photoURL?: string }[] = [];
        groupCall.participants.forEach((p, participantId) => {
          if (participantId !== userId) {
            participantList.push({ oderId: participantId, displayName: p.displayName, photoURL: p.photoURL });
          }
        });

        socket.emit('group-call:participants', {
          callId,
          participants: participantList
        });

        logger.info(`👤 User ${userId} joined group call. Total participants: ${groupCall.participants.size}`);

      } catch (error) {
        logger.error('Error joining group call:', error);
        socket.emit('error', { message: 'Failed to join group call' });
      }
    });

    // Leave a group call
    socket.on('group-call:leave', (data: {
      callId: string;
      reason?: string;
    }) => {
      try {
        const { callId, reason } = data;

        if (!callId) {
          return;
        }

        const groupCall = activeGroupCalls.get(callId);
        if (!groupCall) {
          return;
        }

        logger.info(`👋 User ${userId} leaving group call ${callId}: ${reason}`);

        // Remove user from participants
        groupCall.participants.delete(userId);

        // Notify other participants
        groupCall.participants.forEach((participant, participantId) => {
          io.to(`user:${participantId}`).emit('group-call:user-left', {
            callId,
            userId: userId
          });
        });

        // If no participants left, end the call
        if (groupCall.participants.size === 0) {
          logger.info(`🔴 Group call ${callId} ended - no participants left`);
          activeGroupCalls.delete(callId);
        }

      } catch (error) {
        logger.error('Error leaving group call:', error);
      }
    });

    // Reject a group call
    socket.on('group-call:reject', (data: {
      callId: string;
      reason?: string;
    }) => {
      try {
        const { callId, reason } = data;

        if (!callId) {
          return;
        }

        logger.info(`❌ User ${userId} rejected group call ${callId}: ${reason}`);

        // User rejected - just don't add them to the call
        // No need to notify others unless they were already in

      } catch (error) {
        logger.error('Error rejecting group call:', error);
      }
    });

    // Forward WebRTC offer to specific user in group call
    socket.on('group-call:offer', (data: {
      callId: string;
      toUserId: string;
      offer: any;
    }) => {
      try {
        const { callId, toUserId, offer } = data;

        if (!callId || !toUserId || !offer) {
          return;
        }

        // Forward offer to the target user
        io.to(`user:${toUserId}`).emit('group-call:offer', {
          callId,
          fromUserId: userId,
          offer
        });

      } catch (error) {
        logger.error('Error forwarding group call offer:', error);
      }
    });

    // Forward WebRTC answer to specific user in group call
    socket.on('group-call:answer', (data: {
      callId: string;
      toUserId: string;
      answer: any;
    }) => {
      try {
        const { callId, toUserId, answer } = data;

        if (!callId || !toUserId || !answer) {
          return;
        }

        // Forward answer to the target user
        io.to(`user:${toUserId}`).emit('group-call:answer', {
          callId,
          fromUserId: userId,
          answer
        });

      } catch (error) {
        logger.error('Error forwarding group call answer:', error);
      }
    });

    // Forward ICE candidate to specific user in group call
    socket.on('group-call:ice-candidate', (data: {
      callId: string;
      toUserId: string;
      candidate: any;
    }) => {
      try {
        const { callId, toUserId, candidate } = data;

        if (!callId || !toUserId || !candidate) {
          return;
        }

        // Forward ICE candidate to the target user
        io.to(`user:${toUserId}`).emit('group-call:ice-candidate', {
          callId,
          fromUserId: userId,
          candidate
        });

      } catch (error) {
        logger.error('Error forwarding group call ICE candidate:', error);
      }
    });

    // End entire group call (only initiator can do this)
    socket.on('group-call:end-all', (data: {
      callId: string;
      reason?: string;
    }) => {
      try {
        const { callId, reason } = data;

        if (!callId) {
          return;
        }

        const groupCall = activeGroupCalls.get(callId);
        if (!groupCall) {
          return;
        }

        // Only allow initiator to end the entire call
        if (groupCall.initiatorId !== userId) {
          socket.emit('error', { message: 'Only the call initiator can end the call for everyone' });
          return;
        }

        logger.info(`🔴 Group call ${callId} ended by initiator: ${reason}`);

        // Notify all participants
        groupCall.participants.forEach((participant, participantId) => {
          io.to(`user:${participantId}`).emit('group-call:ended', {
            callId,
            reason: reason || 'Call ended by host'
          });
        });

        // Remove call from active calls
        activeGroupCalls.delete(callId);

      } catch (error) {
        logger.error('Error ending group call:', error);
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
