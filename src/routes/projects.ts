import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as projectsController from '../controllers/projectsController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Project CRUD operations
router.get('/', projectsController.getProjects);
router.post('/', projectsController.createProject);
router.get('/:id', projectsController.getProject);
router.put('/:id', projectsController.updateProject);
router.delete('/:id', projectsController.deleteProject);

// Project member management
router.post('/:id/members', projectsController.addMember);
router.delete('/:id/members/:userId', projectsController.removeMember);
router.put('/:id/members/:userId/role', projectsController.updateMemberRole);

// Project owner management
router.put('/:id/owners/:userId', projectsController.addOwner);
router.delete('/:id/owners/:userId', projectsController.removeOwner);
router.post('/:id/transfer-ownership', projectsController.transferOwnership);

router.delete('/:id/leave', projectsController.leaveProject);

// List/Column management
router.post('/:id/lists', projectsController.addList);
router.put('/:id/lists/:listId', projectsController.updateList);
router.delete('/:id/lists/:listId', projectsController.deleteList);
router.put('/:id/lists/reorder', projectsController.reorderLists);

export default router;
