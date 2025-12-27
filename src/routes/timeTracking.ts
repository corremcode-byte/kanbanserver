import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as timeTrackingController from '../controllers/timeTrackingController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Log time for a task
router.post('/log', timeTrackingController.logTime);

// Get time logs for a task
router.get('/task/:taskId', timeTrackingController.getTaskTimeLogs);

// Get time logs for a project
router.get('/project/:projectId', timeTrackingController.getProjectTimeLogs);

// Get user's time logs
router.get('/my-logs', timeTrackingController.getUserTimeLogs);

// Update time log
router.put('/:timeLogId', timeTrackingController.updateTimeLog);

// Delete time log
router.delete('/:timeLogId', timeTrackingController.deleteTimeLog);

export default router;
