import { Request, Response } from 'express';
import { User } from '../models';
import { pushNotificationService } from '../services/pushNotificationService';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

/**
 * Get VAPID public key for client-side push subscription
 */
export const getVapidPublicKey = async (req: Request, res: Response) => {
  try {
    const publicKey = pushNotificationService.getVapidPublicKey();

    if (!publicKey) {
      return errorResponse(res, 'Push notifications are not configured', 503);
    }

    return successResponse(res, 'VAPID public key retrieved successfully', {
      publicKey
    });
  } catch (error) {
    logger.error('Error getting VAPID public key:', error);
    return internalServerErrorResponse(res, 'Failed to get VAPID public key');
  }
};

/**
 * Subscribe user to push notifications
 */
export const subscribe = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { subscription } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return errorResponse(res, 'Invalid subscription data', 400);
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if subscription already exists
    const existingSubscription = user.pushSubscriptions?.find(
      sub => sub.endpoint === subscription.endpoint
    );

    if (existingSubscription) {
      return successResponse(res, 'Already subscribed to push notifications');
    }

    // Add new subscription
    if (!user.pushSubscriptions) {
      user.pushSubscriptions = [];
    }

    user.pushSubscriptions.push({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth
      }
    });

    await user.save();

    logger.info('User subscribed to push notifications', {
      userId: user._id,
      endpoint: subscription.endpoint.substring(0, 50) + '...'
    });

    return successResponse(res, 'Successfully subscribed to push notifications');
  } catch (error) {
    logger.error('Error subscribing to push notifications:', error);
    return internalServerErrorResponse(res, 'Failed to subscribe to push notifications');
  }
};

/**
 * Unsubscribe user from push notifications
 */
export const unsubscribe = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint) {
      return errorResponse(res, 'Endpoint is required', 400);
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    if (!user.pushSubscriptions || user.pushSubscriptions.length === 0) {
      return successResponse(res, 'No subscriptions found');
    }

    // Remove subscription
    user.pushSubscriptions = user.pushSubscriptions.filter(
      sub => sub.endpoint !== endpoint
    );

    await user.save();

    logger.info('User unsubscribed from push notifications', {
      userId: user._id,
      endpoint: endpoint.substring(0, 50) + '...'
    });

    return successResponse(res, 'Successfully unsubscribed from push notifications');
  } catch (error) {
    logger.error('Error unsubscribing from push notifications:', error);
    return internalServerErrorResponse(res, 'Failed to unsubscribe from push notifications');
  }
};

/**
 * Get user's push notification subscriptions
 */
export const getSubscriptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const subscriptions = user.pushSubscriptions || [];

    return successResponse(res, 'Subscriptions retrieved successfully', {
      subscriptions: subscriptions.map(sub => ({
        endpoint: sub.endpoint,
        // Don't send keys to client
      }))
    });
  } catch (error) {
    logger.error('Error getting push subscriptions:', error);
    return internalServerErrorResponse(res, 'Failed to get push subscriptions');
  }
};

/**
 * Send test push notification
 */
export const sendTestNotification = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pushNotificationService.sendToUser(
      req.user._id,
      {
        title: 'Test Notification',
        body: 'This is a test push notification from Kanban Board',
        icon: '/icon-192x192.png',
        badge: '/badge-72x72.png',
        data: {
          url: '/dashboard',
          type: 'test'
        }
      }
    );

    return successResponse(res, 'Test notification sent', {
      sent: result.sent,
      failed: result.failed
    });
  } catch (error) {
    logger.error('Error sending test notification:', error);
    return internalServerErrorResponse(res, 'Failed to send test notification');
  }
};
