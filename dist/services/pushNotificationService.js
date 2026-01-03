"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushNotificationService = void 0;
const web_push_1 = __importDefault(require("web-push"));
const models_1 = require("../models");
const logger_1 = require("../utils/logger");
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@example.com';
if (!vapidPublicKey || !vapidPrivateKey) {
    logger_1.logger.warn('VAPID keys not configured. Push notifications will not work.');
}
else {
    web_push_1.default.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);
}
class PushNotificationService {
    async sendToSubscription(subscription, payload) {
        try {
            const pushPayload = JSON.stringify(payload);
            await web_push_1.default.sendNotification(subscription, pushPayload);
            logger_1.logger.info('Push notification sent successfully', {
                endpoint: subscription.endpoint.substring(0, 50) + '...'
            });
            return true;
        }
        catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                logger_1.logger.warn('Push subscription expired or invalid', {
                    endpoint: subscription.endpoint.substring(0, 50) + '...',
                    statusCode: error.statusCode
                });
                return false;
            }
            logger_1.logger.error('Failed to send push notification', {
                error: error.message,
                statusCode: error.statusCode
            });
            return false;
        }
    }
    async sendToUser(userId, payload) {
        try {
            const user = await models_1.User.findById(userId);
            if (!user || !user.pushSubscriptions || user.pushSubscriptions.length === 0) {
                logger_1.logger.info('No push subscriptions found for user', { userId });
                return { sent: 0, failed: 0 };
            }
            const results = await Promise.allSettled(user.pushSubscriptions.map(subscription => this.sendToSubscription(subscription, payload)));
            const validSubscriptions = [];
            results.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value === true) {
                    validSubscriptions.push(user.pushSubscriptions[index]);
                }
            });
            if (validSubscriptions.length !== user.pushSubscriptions.length) {
                user.pushSubscriptions = validSubscriptions;
                await user.save();
                logger_1.logger.info('Removed expired push subscriptions', {
                    userId,
                    removed: user.pushSubscriptions.length - validSubscriptions.length
                });
            }
            const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
            const failed = results.length - sent;
            return { sent, failed };
        }
        catch (error) {
            logger_1.logger.error('Failed to send push notification to user', {
                userId,
                error: error.message
            });
            return { sent: 0, failed: 1 };
        }
    }
    async sendToUsers(userIds, payload) {
        const results = await Promise.allSettled(userIds.map(userId => this.sendToUser(userId, payload)));
        const totals = results.reduce((acc, result) => {
            if (result.status === 'fulfilled') {
                acc.sent += result.value.sent;
                acc.failed += result.value.failed;
            }
            else {
                acc.failed += 1;
            }
            return acc;
        }, { sent: 0, failed: 0 });
        return totals;
    }
    async sendTaskAssignedNotification(userId, taskTitle, assignerName, projectId, taskId) {
        const payload = {
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
    async sendTaskMovedNotification(userId, taskTitle, fromList, toList, movedByName, projectId, taskId) {
        const payload = {
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
    getVapidPublicKey() {
        return vapidPublicKey;
    }
}
exports.pushNotificationService = new PushNotificationService();
//# sourceMappingURL=pushNotificationService.js.map