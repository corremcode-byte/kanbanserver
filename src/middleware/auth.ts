import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { errorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: any;
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

    const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

    console.log('Auth debug - Token received from', req.cookies?.auth_token ? 'cookie' : 'header', ', verifying...');
    console.log('Auth debug - Token preview:', token.substring(0, 50) + '...');
    console.log('Auth debug - Using JWT_SECRET:', secret === process.env.JWT_SECRET ? 'from .env' : 'fallback');

    // Verify JWT token
    const decoded = jwt.verify(token, secret) as { userId: string };

    console.log('Auth debug - Token decoded:', decoded);

    if (!decoded || !decoded.userId) {
      console.log('Auth error: Invalid token or missing userId');
      errorResponse(res, 'Invalid token', 401);
      return;
    }

    // Find user in database
    const user = await User.findById(decoded.userId);
    if (!user) {
      console.log('Auth error: User not found in database:', decoded.userId);
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
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      isManager: ['manager', 'admin', 'superadmin'].includes(user.role),
      isSuperAdmin: user.role === 'superadmin'
    };

    console.log('Auth debug - Token verified, user found:', {
      userId: user._id.toString(),
      email: user.email,
      isActive: user.isActive
    });

    next();
  } catch (error) {
    console.error('Auth debug - JWT verification failed:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      console.error('Auth debug - JWT Error details:', error.message);
    } else if (error instanceof Error && error.name === 'TokenExpiredError') {
      console.error('Auth debug - Token has expired');
    }
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

    const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, secret) as { userId: string };

      if (decoded && decoded.userId) {
        // Find user in database
        const user = await User.findById(decoded.userId);
        if (user && user.isActive) {
          req.user = {
            _id: user._id.toString(),
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            isManager: ['manager', 'admin', 'superadmin'].includes(user.role),
            isSuperAdmin: user.role === 'superadmin'
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

  if (!['manager', 'admin', 'superadmin'].includes(req.user.role)) {
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

  if (!['admin', 'superadmin'].includes(req.user.role)) {
    errorResponse(res, 'Admin access required', 403);
    return;
  }

  next();
};

export const requireSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (req.user.role !== 'superadmin') {
    errorResponse(res, 'Super Admin access required', 403);
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
    // Note: Admin role no longer bypasses ownership check.
    // All users must own the resource to access it.

    if (userId !== resourceUserId) {
      errorResponse(res, 'Access denied', 403);
      return;
    }

    next();
  };
};
