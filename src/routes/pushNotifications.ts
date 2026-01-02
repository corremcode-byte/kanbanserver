import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as pushNotificationController from '../controllers/pushNotificationController';

const router = Router();

// Get VAPID public key (no auth required)
router.get('/vapid-public-key', pushNotificationController.getVapidPublicKey);

// All other routes require authentication
router.use(authenticate);

// Subscribe to push notifications
router.post('/subscribe', pushNotificationController.subscribe);

// Unsubscribe from push notifications
router.post('/unsubscribe', pushNotificationController.unsubscribe);

// Get user's subscriptions
router.get('/subscriptions', pushNotificationController.getSubscriptions);

// Send test notification
router.post('/test', pushNotificationController.sendTestNotification);

export default router;
