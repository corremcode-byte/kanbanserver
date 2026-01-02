import webpush from 'web-push';
import { User } from '../models';
import { logger } from '../utils/logger';

// Configure web-push with VAPID keys
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@example.com';

if (!vapidPublicKey || !vapidPrivateKey) {
  logger.warn('VAPID keys not configured. Push notifications will not work.');
} else {
  webpush.setVapidDetails(
    vapidEmail,
    vapidPublicKey,
    vapidPrivateKey
  );
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: {
    url?: string;
    taskId?: string;
    projectId?: string;
    [key: string]: any;
  };
  tag?: string;
  requireInteraction?: boolean;
}

class PushNotificationService {
  /**
   * Send push notification to a single subscription
   */
  async sendToSubscription(
    subscription: PushSubscription,
    payload: PushNotificationPayload
  ): Promise<boolean> {
    try {
      const pushPayload = JSON.stringify(payload);

      await webpush.sendNotification(subscription, pushPayload);

      logger.info('Push notification sent successfully', {
        endpoint: subscription.endpoint.substring(0, 50) + '...'
      });

      return true;
    } catch (error: any) {
      // Handle expired/invalid subscriptions
      if (error.statusCode === 404 || error.statusCode === 410) {
        logger.warn('Push subscription expired or invalid', {
          endpoint: subscription.endpoint.substring(0, 50) + '...',
          statusCode: error.statusCode
        });
        // The subscription should be removed from the database
        return false;
      }

      logger.error('Failed to send push notification', {
        error: error.message,
        statusCode: error.statusCode
      });

      return false;
    }
  }

  /**
   * Send push notification to a user (all their subscriptions)
   */
  async sendToUser(
    userId: string,
    payload: PushNotificationPayload
  ): Promise<{ sent: number; failed: number }> {
    try {
      const user = await User.findById(userId);

      if (!user || !user.pushSubscriptions || user.pushSubscriptions.length === 0) {
        logger.info('No push subscriptions found for user', { userId });
        return { sent: 0, failed: 0 };
      }

      const results = await Promise.allSettled(
        user.pushSubscriptions.map(subscription =>
          this.sendToSubscription(subscription as PushSubscription, payload)
        )
      );

      // Remove expired/invalid subscriptions
      const validSubscriptions: any[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value === true) {
          validSubscriptions.push(user.pushSubscriptions![index]);
        }
      });

      // Update user's subscriptions if any were removed
      if (validSubscriptions.length !== user.pushSubscriptions.length) {
        user.pushSubscriptions = validSubscriptions;
        await user.save();
        logger.info('Removed expired push subscriptions', {
          userId,
          removed: user.pushSubscriptions.length - validSubscriptions.length
        });
      }

      const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      const failed = results.length - sent;

      return { sent, failed };
    } catch (error: any) {
      logger.error('Failed to send push notification to user', {
        userId,
        error: error.message
      });
      return { sent: 0, failed: 1 };
    }
  }

  /**
   * Send push notification to multiple users
   */
  async sendToUsers(
    userIds: string[],
    payload: PushNotificationPayload
  ): Promise<{ sent: number; failed: number }> {
    const results = await Promise.allSettled(
      userIds.map(userId => this.sendToUser(userId, payload))
    );

    const totals = results.reduce(
      (acc, result) => {
        if (result.status === 'fulfilled') {
          acc.sent += result.value.sent;
          acc.failed += result.value.failed;
        } else {
          acc.failed += 1;
        }
        return acc;
      },
      { sent: 0, failed: 0 }
    );

    return totals;
  }

  /**
   * Send task assignment notification
   */
  async sendTaskAssignedNotification(
    userId: string,
    taskTitle: string,
    assignerName: string,
    projectId: string,
    taskId: string
  ): Promise<void> {
    const payload: PushNotificationPayload = {
      title: 'New Task Assigned',
      body: `${assignerName} assigned you to "${taskTitle}"`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        url: `/projects/${projectId}`,
        taskId,
        projectId,
        type: 'task_assigned'
      },
      tag: `task-assigned-${taskId}`,
      requireInteraction: true
    };

    await this.sendToUser(userId, payload);
  }

  /**
   * Send task moved notification
   */
  async sendTaskMovedNotification(
    userId: string,
    taskTitle: string,
    fromList: string,
    toList: string,
    movedByName: string,
    projectId: string,
    taskId: string
  ): Promise<void> {
    const payload: PushNotificationPayload = {
      title: 'Task Moved',
      body: `${movedByName} moved "${taskTitle}" from ${fromList} to ${toList}`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: {
        url: `/projects/${projectId}`,
        taskId,
        projectId,
        type: 'task_moved'
      },
      tag: `task-moved-${taskId}`
    };

    await this.sendToUser(userId, payload);
  }

  /**
   * Get VAPID public key for client-side subscription
   */
  getVapidPublicKey(): string {
    return vapidPublicKey;
  }
}

export const pushNotificationService = new PushNotificationService();
