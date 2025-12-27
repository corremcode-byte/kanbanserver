import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { errorResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import admin from '../config/firebase';

export interface AuthenticatedRequest extends Request {
  user?: any;
  firebaseUser?: any; // Added for Firebase authentication
}

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  console.log('Auth debug - Authentication middleware called for:', req.url);
  try {
    // Try to get token from cookie first, fallback to Authorization header
    let token = req.cookies?.auth_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      console.log('Auth debug - No token found in cookie or authorization header');
      errorResponse(res, 'Authorization token required', 401);
      return;
    }

    const secret = process.env.JWT_SECRET || 'your-default-secret';

    console.log('Auth debug - Token received from', req.cookies?.auth_token ? 'cookie' : 'header', ', verifying...');

    // Verify JWT token
    const decoded = jwt.verify(token, secret) as { id: string };

    console.log('Auth debug - Token decoded:', decoded);

    if (!decoded || !decoded.id) {
      console.log('Auth error: Invalid token or missing id');
      errorResponse(res, 'Invalid token', 401);
      return;
    }

    // Find user in database
    const user = await User.findById(decoded.id);
    if (!user) {
      console.log('Auth error: User not found in database:', decoded.id);
      errorResponse(res, 'User not found', 404);
      return;
    }

    if (!user.isActive) {
      console.log('Auth error: User account is deactivated:', user.email);
      errorResponse(res, 'Account is deactivated', 403);
      return;
    }

    // Attach user to request with proper _id
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
  } catch (error) {
    logger.error('Authentication error:', error);
    errorResponse(res, 'Invalid token', 401);
    return;
  }
};

export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Try to get token from cookie first, fallback to Authorization header
    let token = req.cookies?.auth_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      // No token provided, continue without authentication
      next();
      return;
    }

    const secret = process.env.JWT_SECRET || 'your-default-secret';

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, secret) as { id: string };

      if (decoded && decoded.id) {
        // Find user in database
        const user = await User.findById(decoded.id);
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
    } catch (error) {
      // Invalid token, but continue without authentication
      logger.warn('Optional authentication failed:', error);
    }

    next();
  } catch (error) {
    logger.error('Optional authentication error:', error);
    next();
  }
};

export const requireManagerOrAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!['manager', 'admin'].includes(req.user.role)) {
    errorResponse(res, 'Manager or Admin access required', 403);
    return;
  }

  next();
};

export const requireAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (req.user.role !== 'admin') {
    errorResponse(res, 'Admin access required', 403);
    return;
  }

  next();
};

// Additional middleware functions that might be referenced
export const authorize = (roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    if (!roles.includes(req.user.role)) {
      errorResponse(res, 'Insufficient permissions', 403);
      return;
    }

    next();
  };
};

export const requireActiveUser = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!req.user.isActive) {
    errorResponse(res, 'Account is deactivated', 403);
    return;
  }

  next();
};

export const requireEmailVerified = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!req.user.emailVerified) {
    errorResponse(res, 'Email verification required', 403);
    return;
  }

  next();
};

export const getCurrentUserId = (req: AuthenticatedRequest): string | null => {
  return req.user ? req.user._id.toString() : null;
};

export const requireOwnershipOrAdmin = (resourceUserId: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const userId = req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    
    if (userId !== resourceUserId && !isAdmin) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    next();
  };
};

// Firebase authentication middleware
export const authenticateFirebaseToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      errorResponse(res, 'Firebase token required', 401);
      return;
    }

    const firebaseToken = authHeader.split(' ')[1];

    try {
      // Verify Firebase ID token using Admin SDK
      const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
      if (!decodedToken || !decodedToken.uid || !decodedToken.email) {
        errorResponse(res, 'Invalid Firebase token', 401);
        return;
      }

      // Find user by Firebase UID
      const user = await User.findOne({ firebaseUid: decodedToken.uid });
      if (!user) {
        errorResponse(res, 'User not found', 404);
        return;
      }
      if (!user.isActive) {
        errorResponse(res, 'Account is deactivated', 403);
        return;
      }

      // Attach user to request
      req.user = user;
      req.firebaseUser = decodedToken;
      next();
    } catch (tokenError) {
      logger.error('Firebase token verification error:', tokenError);
      errorResponse(res, 'Invalid Firebase token', 401);
      return;
    }
  } catch (error) {
    logger.error('Firebase authentication error:', error);
    errorResponse(res, 'Authentication failed', 401);
    return;
  }
};