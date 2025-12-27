import { Router } from 'express';
import {
  syncFirebaseUser,
  getCurrentUser,
  getUserByFirebaseUid,
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
} from '../middleware/auth'; // This should work now
import jwt from 'jsonwebtoken';
import admin from '../config/firebase';
import { User } from '../models';
import { successResponse, errorResponse } from '../utils/responses';

const router = Router();

// Public routes (no auth required)
router.post('/sync', syncFirebaseUser);
router.post('/forgot-password', requestPasswordReset);

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

// Debug route - handle GET requests to login (shouldn't happen but helps debug)
router.get('/login', (req, res) => {
  return errorResponse(res, 'Login endpoint requires POST request', 405);
});

router.post('/login', async (req, res) => {
  try {
    console.log('Login route hit - Method:', req.method, 'Body:', req.body);
    const { idToken } = req.body;
    if (!idToken) {
      console.log('Login error: ID token required');
      return errorResponse(res, 'ID token required', 400);
    }
    console.log('Verifying Firebase token...');
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded.uid || !decoded.email) {
      console.log('Login error: Invalid Firebase token');
      return errorResponse(res, 'Invalid Firebase token', 401);
    }
    console.log('Finding user with Firebase UID:', decoded.uid);
    let user = await User.findOne({ firebaseUid: decoded.uid });
    if (!user) {
      console.log('Login error: User not found');
      return errorResponse(res, 'User not found', 404);
    }
    if (!user.isActive) {
      console.log('Login error: Account deactivated');
      return errorResponse(res, 'Account is deactivated', 403);
    }
    // Issue custom JWT (user ID and email only)
    const payload = { id: user._id, email: user.email };
    const secret = process.env.JWT_SECRET || 'your-default-secret';
    const token = jwt.sign(payload, secret, { expiresIn: '7d' });

    // Set HTTP-only cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    console.log('Login successful for user:', user.email);
    return successResponse(res, 'Login successful', {
      token,
      user: { _id: user._id, email: user.email, displayName: user.displayName }
    });
  } catch (err) {
    console.error('Login error:', err);
    return errorResponse(res, 'Login failed', 401);
  }
});
router.post('/signup', async (req, res) => {
  try {
    const { idToken, displayName } = req.body;
    if (!idToken) return errorResponse(res, 'ID token required', 400);
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded.uid || !decoded.email) return errorResponse(res, 'Invalid Firebase token', 401);
    let user = await User.findOne({ firebaseUid: decoded.uid });
    if (!user) {
      // Create new user
      user = new User({
        firebaseUid: decoded.uid,
        email: decoded.email,
        displayName: displayName || decoded.name || decoded.email.split('@')[0],
        photoURL: decoded.picture,
        role: 'member',
        isActive: true,
        lastLoginAt: new Date(),
      });
      await user.save();
    } else if (!user.isActive) {
      return errorResponse(res, 'Account is deactivated', 403);
    }
    // Issue custom JWT (user ID and email only)
    const payload = { id: user._id, email: user.email };
    const secret = process.env.JWT_SECRET || 'your-default-secret';
    const token = jwt.sign(payload, secret, { expiresIn: '7d' });

    // Set HTTP-only cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    return successResponse(res, 'Signup successful', {
      token,
      user: { _id: user._id, email: user.email, displayName: user.displayName }
    });
  } catch (err) {
    return errorResponse(res, 'Signup failed', 401);
  }
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
router.get('/users/firebase/:firebaseUid', getUserByFirebaseUid);

// Admin/Manager only routes
router.put('/users/:userId/role', requireManagerOrAdmin, updateUserRole);

export default router;
