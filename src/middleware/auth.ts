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
      errorResponse(res, 'Authorization token required', 401);
      return;
    }

    const secret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';


    // Verify JWT signature + expiry
    const decoded = jwt.verify(token, secret) as { userId: string; jti?: string };

    if (!decoded?.userId) {
      errorResponse(res, 'Invalid token', 401);
      return;
    }

    // Find user in database
    const user = await User.findById(decoded.userId);
    if (!user) {
      errorResponse(res, 'User not found', 404);
      return;
    }

    if (!user.isActive) {
      errorResponse(res, 'Account is deactivated', 403);
      return;
    }

    // Verify this session is still active (device-limit enforcement)
    if (decoded.jti) {
      const sessionExists = (user.activeSessions || []).some(s => s.jti === decoded.jti);
      if (!sessionExists) {
        errorResponse(res, 'Session expired or logged in from another device', 401);
        return;
      }
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

// Delete All Data is an irreversible whole-database wipe. Super admins always have
// access; everyone else needs the explicit permissions.modules.dataDeletion.execute
// flag, granted the same way as any other module permission (see PermissionsTable.tsx).
export const requireDataDeletionPermission = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (req.user.role === 'superadmin') {
    next();
    return;
  }

  try {
    const user = await User.findById(req.user._id).select('permissions.modules.dataDeletion');
    const hasExecutePermission = user?.permissions?.modules?.dataDeletion?.execute === true;

    if (!hasExecutePermission) {
      errorResponse(res, 'You do not have permission to manage Delete All Data', 403);
      return;
    }

    next();
  } catch (error) {
    logger.error('Error checking Delete All Data permission:', error);
    errorResponse(res, 'Failed to verify permissions', 500);
  }
};

/**
 * Personal Files module permission gate.
 *
 * Same shape as requireDataDeletionPermission above: super admins pass, everyone
 * else needs the explicit permissions.modules.personalFiles.<action> flag, granted
 * the same way as any other module permission (see PermissionsTable.tsx).
 *
 * This answers only "may this user use the Personal Files feature?". It deliberately
 * says NOTHING about which files they may touch - that is ownership, enforced
 * separately by scoping every query in personalFilesController to
 * `userId: req.user._id`. The super-admin fast path therefore grants a super admin
 * access to THEIR OWN drive, never to anyone else's; there is no admin bypass of
 * ownership anywhere in this module.
 *
 * Missing/undefined flags are treated as GRANTED, matching the model default and
 * the client's useModulePermission hook: Personal Files shipped ungated, so an
 * absent flag means "this user predates the permission" and must not lose access.
 * An explicit `false` always denies.
 */
export const requirePersonalFilesPermission = (
  action: 'view' | 'create' | 'edit' | 'delete'
) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    if (req.user.role === 'superadmin') {
      next();
      return;
    }

    try {
      const user = await User.findById(req.user._id).select('permissions.modules.personalFiles');
      const modulePerms = user?.permissions?.modules?.personalFiles;

      // Absent module or absent flag => granted (see note above). Only an explicit
      // false denies.
      const allowed = modulePerms === undefined || modulePerms[action] !== false;

      if (!allowed) {
        errorResponse(res, 'You do not have permission to perform this action on Personal Files', 403);
        return;
      }

      next();
    } catch (error) {
      logger.error('Error checking Personal Files permission:', error);
      errorResponse(res, 'Failed to verify permissions', 500);
    }
  };
};

/**
 * Shared Files module permission gate.
 *
 * Same shape as requirePersonalFilesPermission above (super admins pass, everyone
 * else needs permissions.modules.sharedFiles.<action>), with ONE deliberate
 * difference in default: a missing module or missing flag is DENIED, not granted.
 * Shared Files is a new, opt-in module (the User model defaults it to all-false,
 * matching auditLog/remoteWorkspace/etc.); there are no pre-existing users to
 * grandfather in, and an absent flag on a GLOBAL repository must fail closed.
 * The client hides the sidebar item and shows Access Denied on the same
 * `view !== true` reading, so UI and API can never disagree.
 *
 * This answers only "may this user use the Shared Files feature?". Unlike Personal
 * Files there is NO ownership layer underneath it: the repository is global, and a
 * user who passes this gate may act on every shared item regardless of who
 * uploaded it. `uploadedBy` is metadata, never a filter.
 */
export const requireSharedFilesPermission = (
  action: 'view' | 'create' | 'edit' | 'delete'
) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    if (req.user.role === 'superadmin') {
      next();
      return;
    }

    try {
      const user = await User.findById(req.user._id).select('permissions.modules.sharedFiles');
      const modulePerms = user?.permissions?.modules?.sharedFiles;

      // Fail closed: only an explicit `true` grants.
      const allowed = !!modulePerms && modulePerms[action] === true;

      if (!allowed) {
        errorResponse(res, 'You do not have permission to perform this action on Shared Files', 403);
        return;
      }

      next();
    } catch (error) {
      logger.error('Error checking Shared Files permission:', error);
      errorResponse(res, 'Failed to verify permissions', 500);
    }
  };
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
