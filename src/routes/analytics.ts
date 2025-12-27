import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as analyticsController from '../controllers/analyticsController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Get project analytics (owner only)
router.get('/project/:projectId', analyticsController.getProjectAnalytics);

// Get user-specific analytics (owner only)
router.get('/project/:projectId/user/:userId', analyticsController.getUserAnalytics);

// Get project activity timeline
router.get('/project/:projectId/activity', analyticsController.getProjectActivity);

// Get comprehensive performance matrix
router.get('/project/:projectId/performance-matrix', analyticsController.getPerformanceMatrix);

export default router;
