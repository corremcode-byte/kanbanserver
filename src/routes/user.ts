import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as usersController from '../controllers/userController';

const router = Router();

router.use(authenticate);

// Regular user routes
router.get('/', usersController.getUsers);
router.get('/search', usersController.searchUsers);

// Admin routes for user management
router.get('/all', usersController.getAllUsers);
router.put('/:userId/toggle-active', usersController.toggleUserActiveStatus);
router.put('/:userId/role', usersController.updateUserRole);
router.delete('/:userId', usersController.deleteUser);

export default router;
