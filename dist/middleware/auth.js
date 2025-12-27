"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateFirebaseToken = exports.requireOwnershipOrAdmin = exports.getCurrentUserId = exports.requireEmailVerified = exports.requireActiveUser = exports.authorize = exports.requireAdmin = exports.requireManagerOrAdmin = exports.optionalAuth = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const firebase_1 = __importDefault(require("../config/firebase"));
const authenticate = async (req, res, next) => {
    console.log('Auth debug - Authentication middleware called for:', req.url);
    try {
        let token = req.cookies?.auth_token;
        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            }
        }
        if (!token) {
            console.log('Auth debug - No token found in cookie or authorization header');
            (0, responses_1.errorResponse)(res, 'Authorization token required', 401);
            return;
        }
        const secret = process.env.JWT_SECRET || 'your-default-secret';
        console.log('Auth debug - Token received from', req.cookies?.auth_token ? 'cookie' : 'header', ', verifying...');
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        console.log('Auth debug - Token decoded:', decoded);
        if (!decoded || !decoded.id) {
            console.log('Auth error: Invalid token or missing id');
            (0, responses_1.errorResponse)(res, 'Invalid token', 401);
            return;
        }
        const user = await models_1.User.findById(decoded.id);
        if (!user) {
            console.log('Auth error: User not found in database:', decoded.id);
            (0, responses_1.errorResponse)(res, 'User not found', 404);
            return;
        }
        if (!user.isActive) {
            console.log('Auth error: User account is deactivated:', user.email);
            (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
            return;
        }
        req.user = {
            _id: user._id.toString(),
            firebaseUid: user.firebaseUid,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            isManager: ['manager', 'admin'].includes(user.role)
        };
        console.log('Auth debug - Token verified, user found:', {
            userId: user._id.toString(),
            email: user.email,
            isActive: user.isActive
        });
        next();
    }
    catch (error) {
        logger_1.logger.error('Authentication error:', error);
        (0, responses_1.errorResponse)(res, 'Invalid token', 401);
        return;
    }
};
exports.authenticate = authenticate;
const optionalAuth = async (req, res, next) => {
    try {
        let token = req.cookies?.auth_token;
        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            }
        }
        if (!token) {
            next();
            return;
        }
        const secret = process.env.JWT_SECRET || 'your-default-secret';
        try {
            const decoded = jsonwebtoken_1.default.verify(token, secret);
            if (decoded && decoded.id) {
                const user = await models_1.User.findById(decoded.id);
                if (user && user.isActive) {
                    req.user = {
                        _id: user._id.toString(),
                        firebaseUid: user.firebaseUid,
                        email: user.email,
                        displayName: user.displayName,
                        role: user.role,
                        isManager: ['manager', 'admin'].includes(user.role)
                    };
                }
            }
        }
        catch (error) {
            logger_1.logger.warn('Optional authentication failed:', error);
        }
        next();
    }
    catch (error) {
        logger_1.logger.error('Optional authentication error:', error);
        next();
    }
};
exports.optionalAuth = optionalAuth;
const requireManagerOrAdmin = (req, res, next) => {
    if (!req.user) {
        (0, responses_1.errorResponse)(res, 'Authentication required', 401);
        return;
    }
    if (!['manager', 'admin'].includes(req.user.role)) {
        (0, responses_1.errorResponse)(res, 'Manager or Admin access required', 403);
        return;
    }
    next();
};
exports.requireManagerOrAdmin = requireManagerOrAdmin;
const requireAdmin = (req, res, next) => {
    if (!req.user) {
        (0, responses_1.errorResponse)(res, 'Authentication required', 401);
        return;
    }
    if (req.user.role !== 'admin') {
        (0, responses_1.errorResponse)(res, 'Admin access required', 403);
        return;
    }
    next();
};
exports.requireAdmin = requireAdmin;
const authorize = (roles) => {
    return (req, res, next) => {
        if (!req.user) {
            (0, responses_1.errorResponse)(res, 'Authentication required', 401);
            return;
        }
        if (!roles.includes(req.user.role)) {
            (0, responses_1.errorResponse)(res, 'Insufficient permissions', 403);
            return;
        }
        next();
    };
};
exports.authorize = authorize;
const requireActiveUser = (req, res, next) => {
    if (!req.user) {
        (0, responses_1.errorResponse)(res, 'Authentication required', 401);
        return;
    }
    if (!req.user.isActive) {
        (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        return;
    }
    next();
};
exports.requireActiveUser = requireActiveUser;
const requireEmailVerified = (req, res, next) => {
    if (!req.user) {
        (0, responses_1.errorResponse)(res, 'Authentication required', 401);
        return;
    }
    if (!req.user.emailVerified) {
        (0, responses_1.errorResponse)(res, 'Email verification required', 403);
        return;
    }
    next();
};
exports.requireEmailVerified = requireEmailVerified;
const getCurrentUserId = (req) => {
    return req.user ? req.user._id.toString() : null;
};
exports.getCurrentUserId = getCurrentUserId;
const requireOwnershipOrAdmin = (resourceUserId) => {
    return (req, res, next) => {
        if (!req.user) {
            (0, responses_1.errorResponse)(res, 'Authentication required', 401);
            return;
        }
        const userId = req.user._id.toString();
        const isAdmin = req.user.role === 'admin';
        if (userId !== resourceUserId && !isAdmin) {
            (0, responses_1.errorResponse)(res, 'Access denied', 403);
            return;
        }
        next();
    };
};
exports.requireOwnershipOrAdmin = requireOwnershipOrAdmin;
const authenticateFirebaseToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            (0, responses_1.errorResponse)(res, 'Firebase token required', 401);
            return;
        }
        const firebaseToken = authHeader.split(' ')[1];
        try {
            const decodedToken = await firebase_1.default.auth().verifyIdToken(firebaseToken);
            if (!decodedToken || !decodedToken.uid || !decodedToken.email) {
                (0, responses_1.errorResponse)(res, 'Invalid Firebase token', 401);
                return;
            }
            const user = await models_1.User.findOne({ firebaseUid: decodedToken.uid });
            if (!user) {
                (0, responses_1.errorResponse)(res, 'User not found', 404);
                return;
            }
            if (!user.isActive) {
                (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
                return;
            }
            req.user = user;
            req.firebaseUser = decodedToken;
            next();
        }
        catch (tokenError) {
            logger_1.logger.error('Firebase token verification error:', tokenError);
            (0, responses_1.errorResponse)(res, 'Invalid Firebase token', 401);
            return;
        }
    }
    catch (error) {
        logger_1.logger.error('Firebase authentication error:', error);
        (0, responses_1.errorResponse)(res, 'Authentication failed', 401);
        return;
    }
};
exports.authenticateFirebaseToken = authenticateFirebaseToken;
//# sourceMappingURL=auth.js.map