import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { checkPermission, checkCanEditTask, checkCanDeleteTask } from '../middleware/permissions';
import * as tasksController from '../controllers/tasksController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Task CRUD operations
router.get('/', tasksController.getTasks); // No permission check - users see their assigned tasks
router.get('/:id', tasksController.getTask); // Get single task by ID
router.post('/', checkPermission('canCreateTasks'), tasksController.createTask);
router.put('/:id', checkCanEditTask, tasksController.updateTask);
router.delete('/:id', checkCanDeleteTask, tasksController.deleteTask);

// Task reordering (permission check handled in controller since it's a batch operation)
router.post('/reorder', tasksController.reorderTasks);

export default router;
