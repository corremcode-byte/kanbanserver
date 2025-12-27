import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as auditController from '../controllers/auditController';

const router = Router();

// All routes are protected - any authenticated user can access
router.use(authenticate);

// Get audit logs with optional filters
router.get('/', auditController.getAuditLogs);

export default router;
