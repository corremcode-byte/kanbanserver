import { Router } from 'express';
import {
  login,
  createUser,
  resetPassword,
  getCurrentUser,
  getAllUsers,
  getProfile,
  updateProfile,
  getSettings,
  updateSettings,
  updatePassword,
  deleteAccount,
  uploadAvatar,
  updateUserRole,
  getDashboardData,
  deactivateAccount,
  searchUsers,
  requestPasswordReset
} from '../controllers/authController';
import {
  authenticate,
  requireManagerOrAdmin,
  requireAdmin
} from '../middleware/auth';
import { successResponse } from '../utils/responses';

const router = Router();

// Public routes (no auth required)
router.post('/login', login);
router.post('/forgot-password', requestPasswordReset);
router.post('/reset-password', resetPassword);

// Logout route
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/'
  });
  return successResponse(res, 'Logged out successfully');
});


// Protected routes (require JWT authentication)
router.use(authenticate);

// User profile routes
router.get('/me', getCurrentUser);
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.post('/deactivate', deactivateAccount);

// Settings routes
router.get('/settings', getSettings);
router.put('/settings', updateSettings);

// Password and account management
router.put('/password', updatePassword);
router.delete('/account', deleteAccount);

// Avatar upload
router.post('/avatar', uploadAvatar);

// Dashboard
router.get('/dashboard', getDashboardData);

// User management routes
router.get('/users', getAllUsers);
router.get('/users/search', searchUsers);

// Admin/Manager only routes
router.put('/users/:userId/role', requireManagerOrAdmin, updateUserRole);

export default router;
