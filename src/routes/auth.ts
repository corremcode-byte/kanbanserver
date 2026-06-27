import { Router } from 'express';
import { dynamicRouteStore } from '../lib/dynamicRouteStore';
import {
  login,
  createUser,
  resetPassword,
  getCurrentUser,
  getAllUsers,
  getAllUsersWithPasswords,
  getProfile,
  updateProfile,
  getSettings,
  updateSettings,
  updatePassword,
  deleteAccount,
  uploadAvatar as uploadAvatarController,
  updateUserRole,
  getDashboardData,
  deactivateAccount,
  searchUsers,
  requestPasswordReset,
  setPasskey,
  verifyPasskey,
  changePasskey,
  checkPasskeyStatus,
  getSecurityStatus,
  completeSecurityUpdate,
  getChatLock,
  setChatLock,
  verifyChatLock,
} from '../controllers/authController';
import {
  authenticate,
  optionalAuth,
  requireManagerOrAdmin,
  AuthenticatedRequest,
} from '../middleware/auth';
import { successResponse } from '../utils/responses';
import { User, AuditLog } from '../models';
import { uploadAvatar as uploadAvatarMiddleware } from '../middleware/upload';
import jwt from 'jsonwebtoken';

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────
router.post('/login', login);
router.post('/forgot-password', requestPasswordReset);
router.post('/reset-password', resetPassword);

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', optionalAuth, async (req: AuthenticatedRequest, res) => {
  if (req.user) {
    try {
      const userId = req.user._id?.toString();

      // Remove the jti of this session from activeSessions
      const token = req.cookies?.auth_token
        || (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.split(' ')[1]
          : undefined);

      if (token) {
        try {
          const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
          const decoded = jwt.verify(token, secret) as { jti?: string };
          if (decoded.jti) {
            await User.findByIdAndUpdate(req.user._id, {
              $pull: { activeSessions: { jti: decoded.jti } },
            });
          }
        } catch { /* token may already be expired — ignore */ }
      }

      await Promise.all([
        User.findByIdAndUpdate(req.user._id, { lastLogoutAt: new Date() }),
        userId ? dynamicRouteStore.clearUserRoutes(userId) : Promise.resolve(),
        AuditLog.logSystemEvent({
          userId: req.user._id,
          action: 'user_logout',
          metadata: { userName: req.user.displayName, userEmail: req.user.email },
        }),
      ]);
    } catch (err) {
      console.error('Failed to record logout:', err);
    }
  }
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  });
  return successResponse(res, 'Logged out successfully');
});

// ── Protected routes (require JWT) ───────────────────────────────────────────
router.use(authenticate);

router.get('/me', getCurrentUser);
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.post('/deactivate', deactivateAccount);

router.get('/settings', getSettings);
router.put('/settings', updateSettings);

router.put('/password', updatePassword);
router.delete('/account', deleteAccount);

router.get('/passkey/status', checkPasskeyStatus);
router.post('/passkey/set', setPasskey);
router.post('/passkey/verify', verifyPasskey);
router.put('/passkey/change', changePasskey);

router.get('/security-status', getSecurityStatus);
router.post('/security-complete', completeSecurityUpdate);

router.get('/chat-lock', getChatLock);
router.put('/chat-lock', setChatLock);
router.post('/chat-lock/verify', verifyChatLock);

router.post('/avatar', authenticate, uploadAvatarMiddleware.single('avatar'), uploadAvatarController);

router.get('/dashboard', getDashboardData);

router.get('/users', getAllUsers);
router.get('/users/search', searchUsers);
router.get('/users/with-passwords', getAllUsersWithPasswords);
router.put('/users/:userId/role', requireManagerOrAdmin, updateUserRole);

export default router;
