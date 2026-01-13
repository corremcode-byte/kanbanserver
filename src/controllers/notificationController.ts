import { Request, Response } from 'express';
import { Notification } from '../models/Notification';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
  };
}

// Get user's notifications
export const getUserNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const filter: any = { userId };
    if (unreadOnly === 'true') {
      filter.read = false;
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const total = await Notification.countDocuments(filter);
    const unreadCount = await Notification.countDocuments({ userId, read: false });

    return successResponse(res, 'Notifications retrieved successfully', {
      notifications,
      unreadCount,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error('Error getting notifications:', error);
    return internalServerErrorResponse(res, 'Failed to get notifications');
  }
};

// Mark notification as read
export const markNotificationAsRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { notificationId } = req.params;

    const notification = await Notification.findOne({
      _id: notificationId,
      userId,
    });

    if (!notification) {
      return errorResponse(res, 'Notification not found', 404);
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    return successResponse(res, 'Notification marked as read', notification);
  } catch (error) {
    logger.error('Error marking notification as read:', error);
    return internalServerErrorResponse(res, 'Failed to mark notification as read');
  }
};

// Mark all notifications as read
export const markAllNotificationsAsRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    await Notification.updateMany(
      { userId, read: false },
      { read: true, readAt: new Date() }
    );

    return successResponse(res, 'All notifications marked as read');
  } catch (error) {
    logger.error('Error marking all notifications as read:', error);
    return internalServerErrorResponse(res, 'Failed to mark all notifications as read');
  }
};

// Delete notification
export const deleteNotification = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { notificationId } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      userId,
    });

    if (!notification) {
      return errorResponse(res, 'Notification not found', 404);
    }

    return successResponse(res, 'Notification deleted successfully');
  } catch (error) {
    logger.error('Error deleting notification:', error);
    return internalServerErrorResponse(res, 'Failed to delete notification');
  }
};

// Create notification (helper function)
export const createNotification = async (data: {
  userId: string | mongoose.Types.ObjectId;
  type: 'project_invitation' | 'task_assigned' | 'project_added' | 'task_update' | 'project_update';
  title: string;
  message: string;
  metadata?: {
    projectId?: string | mongoose.Types.ObjectId;
    projectName?: string;
    taskId?: string | mongoose.Types.ObjectId;
    taskTitle?: string;
    invitationId?: string | mongoose.Types.ObjectId;
    actionBy?: string | mongoose.Types.ObjectId;
    actionByName?: string;
  };
}) => {
  try {
    const notification = new Notification({
      userId: data.userId,
      type: data.type,
      title: data.title,
      message: data.message,
      metadata: data.metadata,
      read: false,
    });

    await notification.save();
    logger.info(`Notification created for user ${data.userId}: ${data.title}`);
    return notification;
  } catch (error) {
    logger.error('Error creating notification:', error);
    throw error;
  }
};

// Get unread notification count
export const getUnreadCount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const unreadCount = await Notification.countDocuments({ userId, read: false });

    return successResponse(res, 'Unread count retrieved successfully', { unreadCount });
  } catch (error) {
    logger.error('Error getting unread count:', error);
    return internalServerErrorResponse(res, 'Failed to get unread count');
  }
};
