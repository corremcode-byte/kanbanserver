import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as permissionsController from '../controllers/permissionsController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Get my permissions for a project
router.get('/project/:projectId/me', permissionsController.getMyPermission);

// Get all permissions for a project (owner only)
router.get('/project/:projectId', permissionsController.getProjectPermissions);

// Get specific user permission (owner only)
router.get('/project/:projectId/user/:userId', permissionsController.getUserPermission);

// Update user permissions (owner only)
router.put('/project/:projectId/user/:userId', permissionsController.updateUserPermission);

// Delete user permission/remove from project (owner only)
router.delete('/project/:projectId/user/:userId', permissionsController.deleteUserPermission);

export default router;
