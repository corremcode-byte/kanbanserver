import express from 'express';
import { authenticate } from '../middleware/auth';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadCount,
} from '../controllers/notificationController';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get user's notifications
router.get('/', getUserNotifications);

// Get unread notification count
router.get('/unread-count', getUnreadCount);

// Mark notification as read
router.patch('/:notificationId/read', markNotificationAsRead);

// Mark all notifications as read
router.patch('/mark-all-read', markAllNotificationsAsRead);

// Delete notification
router.delete('/:notificationId', deleteNotification);

export default router;
