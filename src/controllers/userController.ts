import { Request, Response } from 'express';
import { User } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    firebaseUid: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
  firebaseUser?: any;
}

export const getUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const users = await User.find({ isActive: true })
      .select('name email avatar createdAt')
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const total = await User.countDocuments({ isActive: true });
    
    return successResponse(res, 'Users retrieved successfully', {
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error getting users:', error);
    return internalServerErrorResponse(res, 'Failed to get users');
  }
};

export const searchUsers = async (req: Request, res: Response) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return errorResponse(res, 'Search query must be at least 2 characters', 400);
    }

    const users = await User.searchUsers(q.trim(), parseInt(limit as string));
    return successResponse(res, 'Users found', users);
  } catch (error) {
    logger.error('Error searching users:', error);
    return internalServerErrorResponse(res, 'Failed to search users');
  }
};

export const getUserById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select('name email avatar createdAt')
      .where({ isActive: true });

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    return successResponse(res, 'User retrieved successfully', user);
  } catch (error) {
    logger.error('Error getting user by ID:', error);
    return internalServerErrorResponse(res, 'Failed to get user');
  }
};

// User Management Methods (Admin Only)

export const getAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return errorResponse(res, 'Access denied. Only admins can view all users.', 403);
    }

    const users = await User.find()
      .select('firebaseUid email displayName photoURL role isActive lastLoginAt createdAt')
      .sort({ createdAt: -1 });

    const stats = {
      total: users.length,
      active: users.filter(u => u.isActive).length,
      inactive: users.filter(u => !u.isActive).length,
      admins: users.filter(u => u.role === 'admin').length,
    };

    return successResponse(res, 'All users retrieved successfully', { users, stats });
  } catch (error) {
    logger.error('Error getting all users:', error);
    return internalServerErrorResponse(res, 'Failed to get users');
  }
};

export const toggleUserActiveStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return errorResponse(res, 'Access denied. Only admins can modify user status.', 403);
    }

    const { userId } = req.params;
    const { isActive } = req.body;

    // Prevent deactivating self
    if (userId === req.user._id) {
      return errorResponse(res, 'You cannot modify your own account status.', 400);
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    user.isActive = isActive;
    await user.save();

    return successResponse(res, `User ${isActive ? 'activated' : 'deactivated'} successfully`, user);
  } catch (error) {
    logger.error('Error toggling user active status:', error);
    return internalServerErrorResponse(res, 'Failed to update user status');
  }
};

export const updateUserRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return errorResponse(res, 'Access denied. Only admins can modify user roles.', 403);
    }

    const { userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'member'].includes(role)) {
      return errorResponse(res, 'Invalid role. Must be admin or member.', 400);
    }

    // Prevent modifying self
    if (userId === req.user._id) {
      return errorResponse(res, 'You cannot modify your own role.', 400);
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    user.role = role;
    await user.save();

    return successResponse(res, 'User role updated successfully', user);
  } catch (error) {
    logger.error('Error updating user role:', error);
    return internalServerErrorResponse(res, 'Failed to update user role');
  }
};

export const deleteUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return errorResponse(res, 'Access denied. Only admins can delete users.', 403);
    }

    const { userId } = req.params;

    // Prevent deleting self
    if (userId === req.user._id) {
      return errorResponse(res, 'You cannot delete your own account.', 400);
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Delete from Firebase Authentication first
    try {
      const admin = require('../config/firebase').default;
      await admin.auth().deleteUser(user.firebaseUid);
      logger.info(`Deleted Firebase user: ${user.firebaseUid}`);
    } catch (firebaseError: any) {
      // Log but continue if Firebase user doesn't exist
      if (firebaseError.code === 'auth/user-not-found') {
        logger.warn(`Firebase user not found for UID: ${user.firebaseUid}`);
      } else {
        logger.error('Error deleting Firebase user:', firebaseError);
        throw firebaseError; // Re-throw if it's a different error
      }
    }

    // Delete associated project permissions
    const ProjectPermission = require('../models').ProjectPermission;
    try {
      const deletedPerms = await ProjectPermission.deleteMany({ userId });
      logger.info(`Deleted ${deletedPerms.deletedCount} project permissions for user ${userId}`);
    } catch (permError) {
      logger.error('Error deleting user permissions:', permError);
      // Continue with user deletion even if permission deletion fails
    }

    // Delete from MongoDB database
    await User.findByIdAndDelete(userId);

    logger.info(`User deleted successfully: ${user.email} (${userId})`);
    return successResponse(res, 'User deleted successfully', { userId });
  } catch (error) {
    logger.error('Error deleting user:', error);
    return internalServerErrorResponse(res, 'Failed to delete user');
  }
};

export const updateBulkUserPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return errorResponse(res, 'Access denied. Only admins can modify user permissions.', 403);
    }

    const { userIds, permissions } = req.body;

    console.log('Update bulk permissions called:', {
      userIds,
      permissions,
      requestingUserId: req.user?._id,
      requestingUserRole: req.user?.role
    });

    // Validate input
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return errorResponse(res, 'userIds must be a non-empty array', 400);
    }

    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 'permissions must be an object', 400);
    }

    // Update permissions for all selected users
    // Convert boolean values properly - checked = true, unchecked = false
    const updateResult = await User.updateMany(
      { _id: { $in: userIds } },
      {
        $set: {
          permissions: {
            canCreateProjects: permissions.canCreateProjects === true,
            canDeleteProjects: permissions.canDeleteProjects === true,
            canManageAllProjects: permissions.canManageAllProjects === true,
            canViewAllProjects: permissions.canViewAllProjects === true,
            canCreateTasks: permissions.canCreateTasks === true,
            canEditTasks: permissions.canEditTasks === true,
            canDeleteTasks: permissions.canDeleteTasks === true,
            canAssignTasks: permissions.canAssignTasks === true,
            canCreateChatGroups: permissions.canCreateChatGroups === true,
            canEditChatGroups: permissions.canEditChatGroups === true,
            canDeleteChatGroups: permissions.canDeleteChatGroups === true,
            canViewAnalytics: permissions.canViewAnalytics === true,
            canExportData: permissions.canExportData === true,
            canManageUsers: permissions.canManageUsers === true,
            // Module permissions
            modules: permissions.modules ? {
              dashboard: {
                view: permissions.modules.dashboard?.view === true,
                edit: permissions.modules.dashboard?.edit === true
              },
              myTasks: {
                view: permissions.modules.myTasks?.view === true,
                edit: permissions.modules.myTasks?.edit === true
              },
              projects: {
                view: permissions.modules.projects?.view === true,
                edit: permissions.modules.projects?.edit === true
              },
              chat: {
                view: permissions.modules.chat?.view === true,
                edit: permissions.modules.chat?.edit === true
              },
              profile: {
                view: permissions.modules.profile?.view === true,
                edit: permissions.modules.profile?.edit === true
              },
              userManagement: {
                view: permissions.modules.userManagement?.view === true,
                edit: permissions.modules.userManagement?.edit === true
              },
              performance: {
                view: permissions.modules.performance?.view === true,
                edit: permissions.modules.performance?.edit === true
              },
              auditLog: {
                view: permissions.modules.auditLog?.view === true,
                edit: permissions.modules.auditLog?.edit === true
              }
            } : undefined
          }
        }
      }
    );

    logger.info(`Updated permissions for ${updateResult.modifiedCount} users`);

    return successResponse(res, `Permissions updated for ${updateResult.modifiedCount} user(s)`, {
      modifiedCount: updateResult.modifiedCount,
      matchedCount: updateResult.matchedCount
    });
  } catch (error) {
    logger.error('Error updating bulk user permissions:', error);
    return internalServerErrorResponse(res, 'Failed to update user permissions');
  }
};

