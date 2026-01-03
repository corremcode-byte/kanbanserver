"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTestNotification = exports.getSubscriptions = exports.unsubscribe = exports.subscribe = exports.getVapidPublicKey = void 0;
const models_1 = require("../models");
const pushNotificationService_1 = require("../services/pushNotificationService");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const getVapidPublicKey = async (req, res) => {
    try {
        const publicKey = pushNotificationService_1.pushNotificationService.getVapidPublicKey();
        if (!publicKey) {
            return (0, responses_1.errorResponse)(res, 'Push notifications are not configured', 503);
        }
        return (0, responses_1.successResponse)(res, 'VAPID public key retrieved successfully', {
            publicKey
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting VAPID public key:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get VAPID public key');
    }
};
exports.getVapidPublicKey = getVapidPublicKey;
const subscribe = async (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return (0, responses_1.errorResponse)(res, 'Invalid subscription data', 400);
        }
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        const existingSubscription = user.pushSubscriptions?.find(sub => sub.endpoint === subscription.endpoint);
        if (existingSubscription) {
            return (0, responses_1.successResponse)(res, 'Already subscribed to push notifications');
        }
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
        logger_1.logger.info('User subscribed to push notifications', {
            userId: user._id,
            endpoint: subscription.endpoint.substring(0, 50) + '...'
        });
        return (0, responses_1.successResponse)(res, 'Successfully subscribed to push notifications');
    }
    catch (error) {
        logger_1.logger.error('Error subscribing to push notifications:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to subscribe to push notifications');
    }
};
exports.subscribe = subscribe;
const unsubscribe = async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) {
            return (0, responses_1.errorResponse)(res, 'Endpoint is required', 400);
        }
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        if (!user.pushSubscriptions || user.pushSubscriptions.length === 0) {
            return (0, responses_1.successResponse)(res, 'No subscriptions found');
        }
        user.pushSubscriptions = user.pushSubscriptions.filter(sub => sub.endpoint !== endpoint);
        await user.save();
        logger_1.logger.info('User unsubscribed from push notifications', {
            userId: user._id,
            endpoint: endpoint.substring(0, 50) + '...'
        });
        return (0, responses_1.successResponse)(res, 'Successfully unsubscribed from push notifications');
    }
    catch (error) {
        logger_1.logger.error('Error unsubscribing from push notifications:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to unsubscribe from push notifications');
    }
};
exports.unsubscribe = unsubscribe;
const getSubscriptions = async (req, res) => {
    try {
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        const subscriptions = user.pushSubscriptions || [];
        return (0, responses_1.successResponse)(res, 'Subscriptions retrieved successfully', {
            subscriptions: subscriptions.map(sub => ({
                endpoint: sub.endpoint,
            }))
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting push subscriptions:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get push subscriptions');
    }
};
exports.getSubscriptions = getSubscriptions;
const sendTestNotification = async (req, res) => {
    try {
        const result = await pushNotificationService_1.pushNotificationService.sendToUser(req.user._id, {
            title: 'Test Notification',
            body: 'This is a test push notification from Kanban Board',
            icon: '/icon-192x192.png',
            badge: '/badge-72x72.png',
            data: {
                url: '/dashboard',
                type: 'test'
            }
        });
        return (0, responses_1.successResponse)(res, 'Test notification sent', {
            sent: result.sent,
            failed: result.failed
        });
    }
    catch (error) {
        logger_1.logger.error('Error sending test notification:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to send test notification');
    }
};
exports.sendTestNotification = sendTestNotification;
//# sourceMappingURL=pushNotificationController.js.map