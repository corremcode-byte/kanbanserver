import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { logger } from '../utils/logger';

export interface AuthenticatedSocket extends Socket {
  user?: any;
}

// Socket authentication middleware
export const socketAuth = async (socket: AuthenticatedSocket, next: Function) => {
  try {
    const token = socket.handshake.auth?.token;
    
    if (!token) {
      logger.warn('Socket connection attempted without token');
      return next(new Error('Authentication token required'));
    }

    // Verify JWT token
    const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
    const decoded = jwt.verify(token, secret) as { userId: string; id?: string };

    // Support both userId (from auth controller) and id (legacy)
    const userId = decoded.userId || decoded.id;

    if (!decoded || !userId) {
      logger.warn('Invalid token provided for socket connection');
      return next(new Error('Invalid token'));
    }

    // Find user in our database
    const user = await User.findById(userId);
    
    if (!user) {
      logger.warn(`Socket connection attempted for non-existent user: ${userId}`);
      return next(new Error('User not found'));
    }

    if (!user.isActive) {
      logger.warn(`Socket connection attempted for inactive user: ${user.email}`);
      return next(new Error('Account is deactivated'));
    }

    // Attach user data to socket
    socket.user = user;
    
    logger.info(`Socket authenticated for user: ${user.email}`);
    next();
  } catch (error) {
    logger.error('Socket authentication failed:', error);
    next(new Error('Authentication failed'));
  }
};

// Helper to get user ID from socket
export const getSocketUserId = (socket: AuthenticatedSocket): string | null => {
  return socket.user?._id?.toString() || null;
};

// Helper to check if user can join room
export const canJoinRoom = async (socket: AuthenticatedSocket, roomType: string, roomId: string): Promise<boolean> => {
  try {
    const userId = getSocketUserId(socket);
    if (!userId) return false;

    switch (roomType) {
      case 'project': {
        // Handle "all" projects case - any authenticated user can join
        if (roomId === 'all') {
          return true;
        }

        const { Project } = await import('../models');
        const project = await Project.findById(roomId);
        if (!project) return false;

        // Check if user is owner or member
        return project.ownerId.toString() === userId ||
               project.members.some((member: any) => member.toString() === userId);
      }

      case 'user': {
        // Users can only join their own user room
        return roomId === userId;
      }

      default:
        return false;
    }
  } catch (error) {
    logger.error(`Error checking room access for ${roomType}:${roomId}:`, error);
    return false;
  }
};

export default {
  socketAuth,
  getSocketUserId,
  canJoinRoom
};
