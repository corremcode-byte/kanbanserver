import { Router } from 'express';
import authRoutes from './auth';
import projectsRoutes from './projects';
import tasksRoutes from './tasks';
import userRoutes from './user';
import uploadRoutes from './uploadRoutes';
import invitationsRoutes from './invitations';
import permissionsRoutes from './permissions';
import analyticsRoutes from './analytics';
import auditRoutes from './audit';
import pushNotificationRoutes from './pushNotifications';
import commentsRoutes from './comments';
import taskMessagesRoutes from './taskMessages';
import searchRoutes from './search';
import devRoutes from './dev';
import chatRoutes from './chatRoutes';
import notificationsRoutes from './notifications';
import notesRoutes from './notes';
import supportRoutes from './support';
import cronRoutes from './cron';

const router = Router();

// API routes
router.use('/auth', authRoutes);
router.use('/projects', projectsRoutes);
router.use('/tasks', tasksRoutes);
router.use('/users', userRoutes);
router.use('/upload', uploadRoutes);
router.use('/invitations', invitationsRoutes);
router.use('/permissions', permissionsRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/audit', auditRoutes);
router.use('/push-notifications', pushNotificationRoutes);
router.use('/comments', commentsRoutes);
router.use('/task-messages', taskMessagesRoutes);
router.use('/search', searchRoutes);
router.use('/chat', chatRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/notes', notesRoutes);
router.use('/support', supportRoutes);
router.use('/cron', cronRoutes);

// Development-only routes (remove in production)
if (process.env.NODE_ENV !== 'production') {
  router.use('/dev', devRoutes);
}

export default router;