import express from 'express';
import { authenticate } from '../middleware/auth';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadCount,
  getModuleCounts,
  getTaskNotificationStats,
  getTaskNotificationDetails,
  getTaskChatBadges,
  markTaskChatRead,
} from '../controllers/notificationController';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get user's notifications
router.get('/', getUserNotifications);

// Get unread notification count
router.get('/unread-count', getUnreadCount);

// Get per-module unread counts + IDs (lightweight — used by Sidebar badges)
router.get('/module-counts', getModuleCounts);

// Get notification stats for a task
router.get('/stats/task/:taskId', getTaskNotificationStats);

// Get individual notification records for a task
router.get('/details/task/:taskId', getTaskNotificationDetails);

// Task-chat badge counts grouped by taskId
router.get('/task-chat-badges', getTaskChatBadges);

// Mark all unread task-chat notifications for a task as read
router.patch('/mark-task-chat-read/:taskId', markTaskChatRead);

// Mark notification as read
router.patch('/:notificationId/read', markNotificationAsRead);

// Mark all notifications as read
router.patch('/mark-all-read', markAllNotificationsAsRead);

// Delete notification
router.delete('/:notificationId', deleteNotification);

export default router;
