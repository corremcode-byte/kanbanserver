import express from 'express';
import { authenticate } from '../middleware/auth';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadCount,
  getTaskNotificationStats,
  getTaskNotificationDetails,
} from '../controllers/notificationController';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get user's notifications
router.get('/', getUserNotifications);

// Get unread notification count
router.get('/unread-count', getUnreadCount);

// Get notification stats for a task
router.get('/stats/task/:taskId', getTaskNotificationStats);

// Get individual notification records for a task
router.get('/details/task/:taskId', getTaskNotificationDetails);

// Mark notification as read
router.patch('/:notificationId/read', markNotificationAsRead);

// Mark all notifications as read
router.patch('/mark-all-read', markAllNotificationsAsRead);

// Delete notification
router.delete('/:notificationId', deleteNotification);

export default router;
