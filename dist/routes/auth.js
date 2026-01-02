"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const auth_1 = require("../middleware/auth");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const firebase_1 = __importDefault(require("../config/firebase"));
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const router = (0, express_1.Router)();
router.post('/sync', authController_1.syncFirebaseUser);
router.post('/forgot-password', authController_1.requestPasswordReset);
router.post('/logout', (req, res) => {
    res.clearCookie('auth_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        path: '/'
    });
    return (0, responses_1.successResponse)(res, 'Logged out successfully');
});
router.get('/login', (req, res) => {
    return (0, responses_1.errorResponse)(res, 'Login endpoint requires POST request', 405);
});
router.post('/login', async (req, res) => {
    try {
        console.log('Login route hit - Method:', req.method, 'Body:', req.body);
        const { idToken } = req.body;
        if (!idToken) {
            console.log('Login error: ID token required');
            return (0, responses_1.errorResponse)(res, 'ID token required', 400);
        }
        console.log('Verifying Firebase token...');
        const decoded = await firebase_1.default.auth().verifyIdToken(idToken);
        if (!decoded.uid || !decoded.email) {
            console.log('Login error: Invalid Firebase token');
            return (0, responses_1.errorResponse)(res, 'Invalid Firebase token', 401);
        }
        console.log('Finding user with Firebase UID:', decoded.uid);
        let user = await models_1.User.findOne({ firebaseUid: decoded.uid });
        if (!user) {
            console.log('Login error: User not found');
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        if (!user.isActive) {
            console.log('Login error: Account deactivated');
            return (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        }
        const payload = { id: user._id, email: user.email };
        const secret = process.env.JWT_SECRET || 'your-default-secret';
        const token = jsonwebtoken_1.default.sign(payload, secret, { expiresIn: '7d' });
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/'
        });
        console.log('Login successful for user:', user.email);
        return (0, responses_1.successResponse)(res, 'Login successful', {
            token,
            user: { _id: user._id, email: user.email, displayName: user.displayName, role: user.role }
        });
    }
    catch (err) {
        console.error('Login error:', err);
        return (0, responses_1.errorResponse)(res, 'Login failed', 401);
    }
});
router.post('/signup', async (req, res) => {
    try {
        const { idToken, displayName, role = 'member' } = req.body;
        if (!idToken)
            return (0, responses_1.errorResponse)(res, 'ID token required', 400);
        if (role && !['admin', 'member'].includes(role)) {
            return (0, responses_1.errorResponse)(res, 'Invalid role. Must be either admin or member', 400);
        }
        const decoded = await firebase_1.default.auth().verifyIdToken(idToken);
        if (!decoded.uid || !decoded.email)
            return (0, responses_1.errorResponse)(res, 'Invalid Firebase token', 401);
        let user = await models_1.User.findOne({ firebaseUid: decoded.uid });
        if (!user) {
            user = new models_1.User({
                firebaseUid: decoded.uid,
                email: decoded.email,
                displayName: displayName || decoded.name || decoded.email.split('@')[0],
                photoURL: decoded.picture,
                role: role || 'member',
                isActive: true,
                lastLoginAt: new Date(),
            });
            await user.save();
        }
        else if (!user.isActive) {
            return (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        }
        const payload = { id: user._id, email: user.email };
        const secret = process.env.JWT_SECRET || 'your-default-secret';
        const token = jsonwebtoken_1.default.sign(payload, secret, { expiresIn: '7d' });
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/'
        });
        return (0, responses_1.successResponse)(res, 'Signup successful', {
            token,
            user: { _id: user._id, email: user.email, displayName: user.displayName, role: user.role }
        });
    }
    catch (err) {
        return (0, responses_1.errorResponse)(res, 'Signup failed', 401);
    }
});
router.use(auth_1.authenticate);
router.get('/me', authController_1.getCurrentUser);
router.get('/profile', authController_1.getProfile);
router.put('/profile', authController_1.updateProfile);
router.post('/deactivate', authController_1.deactivateAccount);
router.get('/settings', authController_1.getSettings);
router.put('/settings', authController_1.updateSettings);
router.put('/password', authController_1.updatePassword);
router.delete('/account', authController_1.deleteAccount);
router.post('/avatar', authController_1.uploadAvatar);
router.get('/dashboard', authController_1.getDashboardData);
router.get('/users', authController_1.getAllUsers);
router.get('/users/search', authController_1.searchUsers);
router.get('/users/firebase/:firebaseUid', authController_1.getUserByFirebaseUid);
router.put('/users/:userId/role', auth_1.requireManagerOrAdmin, authController_1.updateUserRole);
exports.default = router;
//# sourceMappingURL=auth.js.map