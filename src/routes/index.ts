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
import searchRoutes from './search';
import devRoutes from './dev';

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
router.use('/search', searchRoutes);

// Development-only routes (remove in production)
if (process.env.NODE_ENV !== 'production') {
  router.use('/dev', devRoutes);
}

export default router;