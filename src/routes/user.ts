import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as usersController from '../controllers/userController';

const router = Router();

router.use(authenticate);

// Regular user routes
router.get('/', usersController.getUsers);
router.get('/search', usersController.searchUsers);
router.put('/profile', usersController.updateProfile); // Update own profile

// Admin routes for user management
router.get('/all', usersController.getAllUsers);
router.post('/', usersController.createUser);
router.put('/bulk/permissions', usersController.updateBulkUserPermissions);
router.get('/:userId/permissions', usersController.getUserPermissions);
router.put('/:userId/permissions', usersController.updateUserPermissions);
router.put('/:userId/toggle-active', usersController.toggleUserActiveStatus);
router.put('/:userId/role', usersController.updateUserRole);
router.put('/:userId/profile', usersController.updateUserProfile);
router.get('/:userId/passkey', usersController.getUserPasskey);
router.put('/:userId/passkey', usersController.updateUserPasskey);
router.delete('/delete-all', usersController.deleteAllUsers); // Delete all users (admin only)
router.delete('/:userId', usersController.deleteUser);

// Auto-logout route (user can call this themselves when timer expires)
router.post('/delete-my-auth', usersController.deleteUserAuth);

export default router;
