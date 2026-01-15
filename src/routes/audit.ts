import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth';
import * as auditController from '../controllers/auditController';

const router = Router();

// All routes are protected - require authentication
router.use(authenticate);

// Get audit logs with optional filters
router.get('/', auditController.getAuditLogs);

// Cleanup audit logs for deleted/inactive users (Admin only)
router.post('/cleanup', requireAdmin, auditController.cleanupDeletedUsers);

// Delete all audit logs (Admin only)
router.delete('/', requireAdmin, auditController.deleteAllAuditLogs);

export default router;
