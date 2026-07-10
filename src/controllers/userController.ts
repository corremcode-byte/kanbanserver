import { Request, Response } from 'express';
import { User } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { decrypt, encrypt } from '../utils/encryption';
import { isValidNaclPublicKeyB64 } from '../utils/groupKeyValidation';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

export const getUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const users = await User.find({ isActive: true, role: { $ne: 'superadmin' } })
      .select('name email avatar createdAt')
      .sort({ name: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const total = await User.countDocuments({ isActive: true, role: { $ne: 'superadmin' } });
    
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
    const currentUserId = req.user?._id;
    
    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has viewUsers or view permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasViewUsersPerm = false;
    let hasViewPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasViewUsersPerm = permsObj?.viewUsers === true;
        hasViewPerm = permsObj?.view === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasViewUsersPerm && !hasViewPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to view all users.', 403);
    }

    const users = await User.find({ role: { $ne: 'superadmin' } })
      .select('username email displayName photoURL role isActive lastLoginAt createdAt')
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
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has deactivateActivateUsers permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasDeactivateActivatePerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasDeactivateActivatePerm = permsObj?.deactivateActivateUsers === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasDeactivateActivatePerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to modify user status.', 403);
    }

    const { userId } = req.params;
    const { isActive } = req.body;

    // Prevent deactivating self
    if (userId === req.user?._id) {
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
    // Check if user has managePermissions permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    const currentUser = await User.findById(req.user?._id);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to modify user roles.', 403);
    }

    const { userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'member', 'manager'].includes(role)) {
      return errorResponse(res, 'Invalid role. Must be admin, member, or manager.', 400);
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

export const getUserPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has managePermissions permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to view user permissions.', 403);
    }

    const { userId } = req.params;

    const user = await User.findById(userId).select('permissions');

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    return successResponse(res, 'User permissions retrieved successfully', user.permissions || {});
  } catch (error) {
    logger.error('Error getting user permissions:', error);
    return internalServerErrorResponse(res, 'Failed to get user permissions');
  }
};

export const updateUserPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has managePermissions permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to update user permissions.', 403);
    }

    const { userId } = req.params;
    const { permissions } = req.body;

    // Validate input
    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 'permissions must be an object', 400);
    }

    // Prevent modifying own permissions
    if (userId === req.user._id) {
      return errorResponse(res, 'You cannot modify your own permissions.', 400);
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Update permissions - merge with existing to preserve structure
    if (!user.permissions) {
      user.permissions = {};
    }
    
    // Store modules structure BEFORE updating other permissions
    const existingModules = user.permissions.modules || {};
    
    // Update other permissions (but preserve modules separately)
    const { modules, ...otherPermissions } = permissions;
    Object.assign(user.permissions, otherPermissions);
    
    // Now handle modules separately to ensure they're properly stored
    if (modules) {
      // Merge with existing modules to preserve other module permissions
      if (!user.permissions.modules) {
        user.permissions.modules = {};
      }
      // Deep merge modules to preserve nested structures
      // Use type assertion to handle dynamic module keys
      const modulesObj = user.permissions.modules as Record<string, any>;
      const incomingModules = modules as Record<string, any>;
      Object.keys(incomingModules).forEach(moduleKey => {
        if (!modulesObj[moduleKey]) {
          modulesObj[moduleKey] = {};
        }
        Object.assign(modulesObj[moduleKey], incomingModules[moduleKey]);
      });
      // Update the modules reference
      user.permissions.modules = modulesObj as typeof user.permissions.modules;
    }

    // Map module-based permissions to global User permissions
    // This ensures middleware checks work correctly
    if (user.permissions.modules) {
      // Project permissions
      if (user.permissions.modules.projects) {
        const projectPerms = user.permissions.modules.projects;

        if (projectPerms.createProjects !== undefined) {
          user.permissions.canCreateProjects = projectPerms.createProjects;
        }
        if (projectPerms.deleteProjects !== undefined) {
          user.permissions.canDeleteProjects = projectPerms.deleteProjects;
        }
        if (projectPerms.editProjects !== undefined) {
          user.permissions.canManageAllProjects = projectPerms.editProjects;
        }
        if (projectPerms.viewProjects !== undefined) {
          user.permissions.canViewAllProjects = projectPerms.viewProjects;
        }
        if (projectPerms.personalProjects !== undefined) {
          user.permissions.canCreatePersonalProjects = projectPerms.personalProjects;
        }
        if (projectPerms.manageMembers !== undefined) {
          // Note: manageMembers is project-level, but we store it in modules for consistency
          // The actual check happens at project level via ProjectPermission
        }
      }

      // My Tasks permissions
      if (user.permissions.modules.myTasks) {
        const taskPerms = user.permissions.modules.myTasks;

        if (taskPerms.createTasks !== undefined) {
          user.permissions.canCreateTasks = taskPerms.createTasks;
        }
        if (taskPerms.editTasks !== undefined) {
          user.permissions.canEditTasks = taskPerms.editTasks;
        }
        if (taskPerms.deleteTasks !== undefined) {
          user.permissions.canDeleteTasks = taskPerms.deleteTasks;
        }
        if (taskPerms.assignTasks !== undefined) {
          user.permissions.canAssignTasks = taskPerms.assignTasks;
        }
      }
    }

    // Mark permissions as modified for Mongoose
    user.markModified('permissions');
    user.markModified('permissions.canCreateProjects');
    user.markModified('permissions.canDeleteProjects');
    user.markModified('permissions.canManageAllProjects');
    user.markModified('permissions.canViewAllProjects');
    user.markModified('permissions.canCreatePersonalProjects');
    if (user.permissions.modules) {
      user.markModified('permissions.modules');
      if (user.permissions.modules.projects) {
        user.markModified('permissions.modules.projects');
      }
    }

    await user.save();
    
    // Verify what was saved
    const savedUser = await User.findById(userId);
    logger.info(`Admin ${req.user.email} updated permissions for user ${user.email}`);

    return successResponse(res, 'User permissions updated successfully', { user });
  } catch (error) {
    logger.error('Error updating user permissions:', error);
    return internalServerErrorResponse(res, 'Failed to update user permissions');
  }
};

export const updateBulkUserPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user has managePermissions permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    const currentUser = await User.findById(req.user?._id);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to update user permissions.', 403);
    }

    const { userIds, permissions } = req.body;

    // Validate input
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return errorResponse(res, 'userIds must be a non-empty array', 400);
    }

    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 'permissions must be an object', 400);
    }

    // Prevent modifying own permissions
    if (userIds.includes(req.user._id)) {
      return errorResponse(res, 'You cannot modify your own permissions.', 400);
    }

    // Update permissions for all specified users
    const updatedUsers = [];
    const errors = [];

    for (const userId of userIds) {
      try {
        const user = await User.findById(userId);
        if (!user) {
          errors.push({ userId, error: 'User not found' });
          continue;
        }

        // Merge new permissions with existing permissions
        if (!user.permissions) {
          user.permissions = {};
        }

        // Create a copy of permissions to avoid mutating the original
        const permissionsToApply = { ...permissions };

        // Handle modules separately if they exist
        if (permissionsToApply.modules) {
          if (!user.permissions.modules) {
            user.permissions.modules = {};
          }
          // Merge module permissions
          Object.assign(user.permissions.modules, permissionsToApply.modules);

          // Map module-based permissions to global User permissions
          // Projects
          if (permissionsToApply.modules.projects) {
            const projectPerms = permissionsToApply.modules.projects;

            if (projectPerms.createProjects !== undefined) {
              user.permissions.canCreateProjects = projectPerms.createProjects;
            }
            if (projectPerms.deleteProjects !== undefined) {
              user.permissions.canDeleteProjects = projectPerms.deleteProjects;
            }
            if (projectPerms.editProjects !== undefined) {
              user.permissions.canManageAllProjects = projectPerms.editProjects;
            }
            if (projectPerms.viewProjects !== undefined) {
              user.permissions.canViewAllProjects = projectPerms.viewProjects;
            }
            if (projectPerms.personalProjects !== undefined) {
              user.permissions.canCreatePersonalProjects = projectPerms.personalProjects;
            }
            if (projectPerms.manageMembers !== undefined) {
              // Note: manageMembers is project-level, but we store it in modules for consistency
              // The actual check happens at project level via ProjectPermission
            }
          }

          // My Tasks
          if (permissionsToApply.modules.myTasks) {
            const taskPerms = permissionsToApply.modules.myTasks;

            if (taskPerms.createTasks !== undefined) {
              user.permissions.canCreateTasks = taskPerms.createTasks;
            }
            if (taskPerms.editTasks !== undefined) {
              user.permissions.canEditTasks = taskPerms.editTasks;
            }
            if (taskPerms.deleteTasks !== undefined) {
              user.permissions.canDeleteTasks = taskPerms.deleteTasks;
            }
            if (taskPerms.assignTasks !== undefined) {
              user.permissions.canAssignTasks = taskPerms.assignTasks;
            }
          }
          delete permissionsToApply.modules;
        }


        // Update other permissions (excluding modules which we already handled)
        Object.assign(user.permissions, permissionsToApply);


        // Mark permissions as modified for Mongoose
        user.markModified('permissions');
        user.markModified('permissions.canCreateProjects');
        user.markModified('permissions.canDeleteProjects');
        user.markModified('permissions.canManageAllProjects');
        user.markModified('permissions.canViewAllProjects');
        user.markModified('permissions.canCreatePersonalProjects');
        await user.save();

        // Verify what was actually saved
        const savedUser = await User.findById(userId);
        updatedUsers.push({
          userId: user._id,
          email: user.email,
          displayName: user.displayName
        });
      } catch (error: any) {
        logger.error(`Error updating permissions for user ${userId}:`, error);
        errors.push({ userId, error: error.message || 'Failed to update permissions' });
      }
    }

    if (updatedUsers.length === 0) {
      return errorResponse(res, 'Failed to update any user permissions', 500);
    }

    return successResponse(res, `Permissions updated for ${updatedUsers.length} user(s)`, {
      updated: updatedUsers,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    logger.error('Error updating bulk user permissions:', error);
    return internalServerErrorResponse(res, 'Failed to update user permissions');
  }
};

export const createUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;
    
    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has addUsers permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasAddUsersPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasAddUsersPerm = permsObj?.addUsers === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasAddUsersPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to create users.', 403);
    }

    const { username, email, password, displayName, role = 'member', permissions } = req.body;

    // Validate required fields - username is now optional
    if (!email || !email.trim()) {
      return errorResponse(res, 'Email is required', 400);
    }

    // Only allow @mail.com email addresses for new registrations
    if (!email.toLowerCase().trim().endsWith('@mail.com')) {
      return errorResponse(res, 'Only @mail.com email addresses are allowed for registration', 400);
    }

    if (!password || password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters', 400);
    }

    if (!displayName || !displayName.trim()) {
      return errorResponse(res, 'Display name is required', 400);
    }

    // Validate role
    if (role && !['admin', 'member', 'manager'].includes(role)) {
      return errorResponse(res, 'Invalid role. Must be admin, member, or manager', 400);
    }

    // Validate username format only if provided and not empty (username is optional)
    if (username && username.trim().length > 0) {
      const usernameRegex = /^[a-z0-9_-]{3,20}$/;
      if (!usernameRegex.test(username.trim().toLowerCase())) {
        return errorResponse(res, 'Username must be 3-20 characters long and contain only lowercase letters, numbers, hyphens, and underscores', 400);
      }

      // Check if username is already taken
      const existingUsername = await User.findOne({ username: username.toLowerCase().trim() });
      if (existingUsername) {
        return errorResponse(res, 'Username is already taken', 400);
      }
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    // Check if displayName is already taken
    const existingDisplayName = await User.findOne({ displayName: displayName.trim() });
    if (existingDisplayName) {
      return errorResponse(res, 'Display name is already taken', 400);
    }

    // Process permissions object
    let processedPermissions: any = permissions || {};

    // Handle auto-logout settings
    if (processedPermissions.autoLogoutTimerMinutes !== undefined) {
      // Only set autoLogoutTimerMinutes if autoLogout is true and timer is > 0
      if (!processedPermissions.autoLogout || !processedPermissions.autoLogoutTimerMinutes || processedPermissions.autoLogoutTimerMinutes <= 0) {
        processedPermissions.autoLogout = false;
        processedPermissions.autoLogoutTimerMinutes = undefined;
      }
    }

    // Ensure modules are properly structured
    if (processedPermissions.modules) {
      // Mark modules as modified to ensure Mongoose saves them
      Object.keys(processedPermissions.modules).forEach(moduleKey => {
        if (processedPermissions.modules[moduleKey]) {
          // Ensure each module has at least view and edit
          if (typeof processedPermissions.modules[moduleKey] === 'object') {
            processedPermissions.modules[moduleKey] = {
              ...processedPermissions.modules[moduleKey]
            };
          }
        }
      });

      // Map module-based permissions to global User permissions
      // Projects
      if (processedPermissions.modules.projects) {
        const projectPerms = processedPermissions.modules.projects;
        if (projectPerms.createProjects !== undefined) {
          processedPermissions.canCreateProjects = projectPerms.createProjects;
        }
        if (projectPerms.deleteProjects !== undefined) {
          processedPermissions.canDeleteProjects = projectPerms.deleteProjects;
        }
        if (projectPerms.editProjects !== undefined) {
          processedPermissions.canManageAllProjects = projectPerms.editProjects;
        }
        if (projectPerms.viewProjects !== undefined) {
          processedPermissions.canViewAllProjects = projectPerms.viewProjects;
        }
        if (projectPerms.personalProjects !== undefined) {
          processedPermissions.canCreatePersonalProjects = projectPerms.personalProjects;
        }
        if (projectPerms.manageMembers !== undefined) {
          // Note: manageMembers is project-level, but we store it in modules for consistency
          // The actual check happens at project level via ProjectPermission
        }
      }

      // My Tasks
      if (processedPermissions.modules.myTasks) {
        const taskPerms = processedPermissions.modules.myTasks;
        if (taskPerms.createTasks !== undefined) {
          processedPermissions.canCreateTasks = taskPerms.createTasks;
        }
        if (taskPerms.editTasks !== undefined) {
          processedPermissions.canEditTasks = taskPerms.editTasks;
        }
        if (taskPerms.deleteTasks !== undefined) {
          processedPermissions.canDeleteTasks = taskPerms.deleteTasks;
        }
        if (taskPerms.assignTasks !== undefined) {
          processedPermissions.canAssignTasks = taskPerms.assignTasks;
        }
      }
    }

    // Generate unique username if not provided or empty
    let finalUsername = username?.toLowerCase().trim();
    if (!finalUsername || finalUsername.length === 0) {
      // Generate from email, sanitized to match schema regex
      finalUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      // Ensure minimum length of 3 characters
      if (finalUsername.length < 3) {
        finalUsername = finalUsername + '_user';
      }
    }

    // Check if generated username is already taken and make it unique
    let existingUsernameCheck = await User.findOne({ username: finalUsername });
    if (existingUsernameCheck) {
      let counter = 1;
      const baseUsername = finalUsername;
      while (existingUsernameCheck) {
        finalUsername = `${baseUsername}_${counter}`;
        existingUsernameCheck = await User.findOne({ username: finalUsername });
        counter++;
      }
      logger.info(`Username was taken, generated unique name: ${finalUsername}`);
    }

    // Create user in database with password (will be hashed by pre-save middleware)
    const userData: any = {
      email: email.toLowerCase().trim(),
      password: password, // Will be hashed by pre-save middleware
      username: finalUsername,
      displayName: displayName.trim(),
      role: role || 'member',
      isActive: true,
      lastLoginAt: new Date(),
      permissions: processedPermissions,
    };
    
    const user = new User(userData);

    // Mark permissions as modified to ensure Mongoose saves nested objects
    if (user.permissions) {
      user.markModified('permissions');
      if (user.permissions.modules) {
        user.markModified('permissions.modules');
      }
      // Also mark global permission fields
      user.markModified('permissions.canCreateProjects');
      user.markModified('permissions.canDeleteProjects');
      user.markModified('permissions.canManageAllProjects');
      user.markModified('permissions.canViewAllProjects');
      user.markModified('permissions.canCreatePersonalProjects');
    }

    await user.save();

    // Log user creation event to audit logs
    try {
      const { AuditLog } = require('../models/AuditLog');
      await AuditLog.logSystemEvent({
        userId: currentUserId.toString(), // The user who created this account
        action: 'user_created',
        metadata: {
          userName: user.displayName,
          userEmail: user.email,
          role: user.role,
          createdBy: currentUser.displayName || currentUser.email
        }
      });
    } catch (auditError) {
      // Don't fail user creation if audit logging fails
      logger.error('Failed to log user creation event:', auditError);
    }

    logger.info(`User created successfully: ${user.username} / ${user.email} (${user._id})`);
    return successResponse(res, 'User created successfully', {
      _id: user._id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions,
    });
  } catch (error: any) {
    logger.error('Error creating user:', error);
    logger.error('Error stack:', error.stack);
    logger.error('Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      errors: error.errors
    });

    // Handle duplicate key error
    if (error.code === 11000) {
      if (error.keyPattern?.email) {
        return errorResponse(res, 'User with this email already exists', 400);
      }
      if (error.keyPattern?.username) {
        return errorResponse(res, 'This username is already taken', 400);
      }
      if (error.keyPattern?.displayName) {
        return errorResponse(res, 'This display name is already taken', 400);
      }
      if (error.keyPattern?.firebaseUid) {
        logger.error('firebaseUid duplicate key error detected. The firebaseUid index needs to be dropped.');
        logger.error('Run: npm run drop-firebase-index or ts-node src/scripts/dropFirebaseIndex.ts');
        return errorResponse(res, 'Database configuration error. Please contact administrator.', 500);
      }
      // Generic duplicate key error
      const duplicateField = error.keyPattern ? Object.keys(error.keyPattern)[0] : 'unknown field';
      return errorResponse(res, `Duplicate value for ${duplicateField}`, 400);
    }

    // Return more specific error message
    const errorMessage = error.message || 'Failed to create user';
    if (error.name === 'ValidationError') {
      return errorResponse(res, `Validation error: ${errorMessage}`, 400);
    }
    
    return internalServerErrorResponse(res, errorMessage);
  }
};

export const deleteUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has deleteUsers permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasDeleteUsersPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasDeleteUsersPerm = permsObj?.deleteUsers === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasDeleteUsersPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to delete users.', 403);
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

    logger.info(`Starting deletion of user ${user.email} (${userId}) and all associated data`);

    // Import all required models
    const {
      ProjectPermission,
      Project,
      Task,
      Message,
      ChatGroup,
      ProjectInvitation,
      TaskTimeLog,
      AuditLog
    } = require('../models');

    let deletionSummary: any = {};

    // 1. Delete project permissions
    try {
      const deletedPerms = await ProjectPermission.deleteMany({ userId });
      deletionSummary.projectPermissions = deletedPerms.deletedCount;
      logger.info(`Deleted ${deletedPerms.deletedCount} project permissions`);
    } catch (error) {
      logger.error('Error deleting project permissions:', error);
    }

    // 2. Delete or reassign projects owned by the user
    try {
      const ownedProjects = await Project.find({ ownerId: userId });
      deletionSummary.projectsOwned = ownedProjects.length;

      for (const project of ownedProjects) {
        // Delete all tasks in the project
        await Task.deleteMany({ projectId: project._id });
        // Delete the project
        await Project.findByIdAndDelete(project._id);
      }
      logger.info(`Deleted ${ownedProjects.length} projects owned by user`);
    } catch (error) {
      logger.error('Error deleting owned projects:', error);
    }

    // 3. Remove user from project members and managers
    try {
      const updatedProjects = await Project.updateMany(
        { $or: [{ members: userId }, { managers: userId }] },
        {
          $pull: {
            members: userId,
            managers: userId
          }
        }
      );
      deletionSummary.projectMemberships = updatedProjects.modifiedCount;
      logger.info(`Removed user from ${updatedProjects.modifiedCount} projects`);
    } catch (error) {
      logger.error('Error removing user from projects:', error);
    }

    // 4. Delete tasks assigned to or created by the user
    try {
      const deletedTasks = await Task.deleteMany({
        $or: [
          { assigneeId: userId },
          { 'assignees': userId },
          { createdBy: userId }
        ]
      });
      deletionSummary.tasks = deletedTasks.deletedCount;
      logger.info(`Deleted ${deletedTasks.deletedCount} tasks`);
    } catch (error) {
      logger.error('Error deleting tasks:', error);
    }

    // 5. Delete messages sent by the user
    try {
      const deletedMessages = await Message.deleteMany({ senderId: userId });
      deletionSummary.messages = deletedMessages.deletedCount;
      logger.info(`Deleted ${deletedMessages.deletedCount} messages`);
    } catch (error) {
      logger.error('Error deleting messages:', error);
    }

    // 6. Delete or reassign chat groups created by the user
    try {
      const deletedChatGroups = await ChatGroup.deleteMany({ createdBy: userId });
      deletionSummary.chatGroups = deletedChatGroups.deletedCount;
      logger.info(`Deleted ${deletedChatGroups.deletedCount} chat groups`);
    } catch (error) {
      logger.error('Error deleting chat groups:', error);
    }

    // 7. Remove user from chat group members
    try {
      await ChatGroup.updateMany(
        { members: userId },
        { $pull: { members: userId } }
      );
    } catch (error) {
      logger.error('Error removing user from chat groups:', error);
    }

    // 8. Delete project invitations sent to or by the user
    try {
      const deletedInvitations = await ProjectInvitation.deleteMany({
        $or: [
          { email: user.email },
          { invitedBy: userId }
        ]
      });
      deletionSummary.invitations = deletedInvitations.deletedCount;
      logger.info(`Deleted ${deletedInvitations.deletedCount} project invitations`);
    } catch (error) {
      logger.error('Error deleting invitations:', error);
    }

    // 9. Delete time logs created by the user
    try {
      const deletedTimeLogs = await TaskTimeLog.deleteMany({ userId });
      deletionSummary.timeLogs = deletedTimeLogs.deletedCount;
      logger.info(`Deleted ${deletedTimeLogs.deletedCount} time logs`);
    } catch (error) {
      logger.error('Error deleting time logs:', error);
    }

    // 10. Delete audit logs for the deleted user
    try {
      const deletedAuditLogs = await AuditLog.deleteMany({ userId });
      deletionSummary.auditLogs = deletedAuditLogs.deletedCount;
      logger.info(`Deleted ${deletedAuditLogs.deletedCount} audit logs for deleted user`);
    } catch (error) {
      logger.error('Error deleting audit logs:', error);
    }

    // 11. Finally, delete the user from MongoDB database
    await User.findByIdAndDelete(userId);

    logger.info(`User deleted successfully: ${user.email} (${userId})`);
    logger.info(`Deletion summary:`, deletionSummary);

    return successResponse(res, 'User and all associated data deleted successfully', {
      userId,
      deletionSummary
    });
  } catch (error) {
    logger.error('Error deleting user:', error);
    return internalServerErrorResponse(res, 'Failed to delete user');
  }
};

// Update user profile (name, email, password)
export const updateUserProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;
    
    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has editUsers or managePermissions permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    let hasEditUsersPerm = false;
    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasEditUsersPerm = permsObj?.editUsers === true;
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasEditUsersPerm && !hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to update user profiles.', 403);
    }

    const { userId } = req.params;
    const { displayName, email, currentPassword, password } = req.body;

    // Prevent updating self through this endpoint
    if (userId.toString() === currentUserId.toString()) {
      return errorResponse(res, 'You cannot update your own profile through this endpoint.', 400);
    }

    const user = await User.findById(userId).select('+password');
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }
    const previousEmail = user.email;
    let emailUpdated = false;
    let passwordUpdated = false;

    // Update fields if provided
    if (displayName !== undefined) {
      if (!displayName.trim()) {
        return errorResponse(res, 'Display name cannot be empty', 400);
      }
      user.displayName = displayName.trim();
    }

    if (email !== undefined) {
      if (!email.trim()) {
        return errorResponse(res, 'Email cannot be empty', 400);
      }

      // Check if email is already taken by another user
      const existingUser = await User.findOne({
        email: email.trim(),
        _id: { $ne: userId }
      });

      if (existingUser) {
        return errorResponse(res, 'Email is already taken by another user', 400);
      }

      user.email = email.trim();
      emailUpdated = true;
    }

    if (password !== undefined) {
      if (password.length < 6) {
        return errorResponse(res, 'New password must be at least 6 characters long', 400);
      }
      user.password = password; // Will be hashed by pre-save hook
      passwordUpdated = true;
    }

    try {
      await user.save();
    } catch (saveError) {
      logger.error('Error saving user profile:', saveError);
      const saveErrorMessage = saveError instanceof Error ? saveError.message : 'Unknown save error';
      return errorResponse(res, `Failed to save user profile: ${saveErrorMessage}`, 500);
    }

    logger.info(`User profile updated for ${user.email} (${userId}) by ${currentUser.email}`);
    if (emailUpdated || passwordUpdated) {
      try {
        const { AuditLog } = require('../models/AuditLog');
        await AuditLog.logSystemEvent({
          userId: currentUserId.toString(),
          action: 'user_sensitive_profile_updated_by_admin',
          metadata: {
            targetUserId: user._id.toString(),
            targetUserEmail: user.email,
            previousEmail: emailUpdated ? previousEmail : undefined,
            emailUpdated,
            passwordUpdated,
            updatedBy: currentUser.displayName || currentUser.email
          }
        });
      } catch (auditError) {
        logger.error('Failed to log admin sensitive profile update event:', auditError);
      }
    }
    if (emailUpdated || passwordUpdated) {
      try {
        const { AuditLog } = require('../models/AuditLog');
        await AuditLog.logSystemEvent({
          userId: currentUserId.toString(),
          action: 'user_sensitive_profile_updated_by_admin',
          metadata: {
            targetUserId: user._id.toString(),
            targetUserEmail: user.email,
            previousEmail: emailUpdated ? previousEmail : undefined,
            emailUpdated,
            passwordUpdated,
            updatedBy: currentUser.displayName || currentUser.email
          }
        });
      } catch (auditError) {
        logger.error('Failed to log admin sensitive profile update event:', auditError);
      }
    }

    return successResponse(res, 'User profile updated successfully', {
      user: {
        _id: user._id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    logger.error('Error updating user profile:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error details:', { errorMessage, stack: error instanceof Error ? error.stack : undefined });
    return internalServerErrorResponse(res, `Failed to update user profile: ${errorMessage}`);
  }
};

// Deactivate user auth (for auto-logout) - MongoDB only
export const deleteUserAuth = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      return errorResponse(res, 'Unauthorized', 401);
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has autoLogout permission
    if (!user.permissions?.autoLogout) {
      return errorResponse(res, 'Auto-logout permission not set', 403);
    }

    // Deactivate user in database (logout by marking as inactive)
    user.isActive = false;
    user.permissions = user.permissions || {};
    user.permissions.autoLogout = false; // Clear the permission
    await user.save();

    logger.info(`User auth deleted for auto-logout: ${user.email} (${userId})`);
    return successResponse(res, 'User credentials deleted successfully', { userId });
  } catch (error) {
    logger.error('Error deleting user auth:', error);
    return internalServerErrorResponse(res, 'Failed to delete user credentials');
  }
};

// Delete all users (requires deleteUsers permission, excludes current user)
export const deleteAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Check if user has deleteUsers permission for userManagement module
    // Note: Admin role no longer bypasses permission checks
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    let hasDeleteUsersPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasDeleteUsersPerm = permsObj?.deleteUsers === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasDeleteUsersPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to delete users.', 403);
    }

    // Delete all users except the current user
    const result = await User.deleteMany({
      _id: { $ne: currentUserId }
    });

    logger.warn(`All users deleted by admin: ${req.user.email}. Count: ${result.deletedCount}`);

    return successResponse(res, `Successfully deleted ${result.deletedCount} users`, {
      deletedCount: result.deletedCount
    });
  } catch (error) {
    logger.error('Error deleting all users:', error);
    return internalServerErrorResponse(res, 'Failed to delete all users');
  }
};

// Update user profile (with permission checks)
export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { displayName, email, password, currentPassword } = req.body;

    // Find the user with permissions
    const user = await User.findById(userId).select('+password');
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const previousEmail = user.email;
    let emailUpdated = false;
    let passwordUpdated = false;
    let updated = false;

    // Update display name (requires canEditDisplayName permission)
    // Note: Admin role no longer bypasses permission checks
    if (displayName !== undefined && displayName !== user.displayName) {
      if (!user.permissions?.canEditDisplayName) {
        return errorResponse(res, 'You do not have permission to edit your display name', 403);
      }

      // Check if display name is already taken
      const existingDisplayName = await User.findOne({
        displayName: displayName.trim(),
        _id: { $ne: userId }
      });
      if (existingDisplayName) {
        return errorResponse(res, 'Display name is already taken', 400);
      }

      user.displayName = displayName.trim();
      updated = true;
    }

    // Update email (requires canEditEmail permission)
    // Note: Admin role no longer bypasses permission checks
    if (email !== undefined && email !== user.email) {
      if (!user.permissions?.canEditEmail) {
        return errorResponse(res, 'You do not have permission to edit your email', 403);
      }

      // Validate email format
      const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
      if (!emailRegex.test(email)) {
        return errorResponse(res, 'Invalid email format', 400);
      }

      // Check if email is already taken
      const existingEmail = await User.findOne({
        email: email.toLowerCase().trim(),
        _id: { $ne: userId }
      });
      if (existingEmail) {
        return errorResponse(res, 'Email is already taken', 400);
      }

      user.email = email.toLowerCase().trim();
      emailUpdated = true;
      updated = true;
    }

    // Update password (requires canEditPassword permission)
    // Note: Admin role no longer bypasses permission checks
    if (password !== undefined) {
      if (!user.permissions?.canEditPassword) {
        return errorResponse(res, 'You do not have permission to edit your password', 403);
      }

      // Require current password for security
      if (!currentPassword) {
        return errorResponse(res, 'Current password is required to change password', 400);
      }

      // Verify current password
      const isPasswordValid = await user.comparePassword(currentPassword);
      if (!isPasswordValid) {
        return errorResponse(res, 'Current password is incorrect', 400);
      }

      // Validate new password
      if (password.length < 6) {
        return errorResponse(res, 'New password must be at least 6 characters', 400);
      }

      user.password = password;
      passwordUpdated = true;
      updated = true;
    }

    if (!updated) {
      return errorResponse(res, 'No valid fields to update', 400);
    }

    await user.save();

    if (emailUpdated || passwordUpdated) {
      try {
        const { AuditLog } = require('../models/AuditLog');
        await AuditLog.logSystemEvent({
          userId: user._id.toString(),
          action: 'user_sensitive_profile_updated',
          metadata: {
            userEmail: user.email,
            previousEmail: emailUpdated ? previousEmail : undefined,
            emailUpdated,
            passwordUpdated
          }
        });
      } catch (auditError) {
        logger.error('Failed to log sensitive profile update event:', auditError);
      }
    }

    logger.info(`User profile updated: ${user.username} (${user._id})`);
    return successResponse(res, 'Profile updated successfully', {
      _id: user._id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: user.role,
    });
  } catch (error) {
    logger.error('Error updating profile:', error);
    return internalServerErrorResponse(res, 'Failed to update profile');
  }
};

// Get user's decrypted passkey (Admin only - for user management)
export const getUserPasskey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has managePermissions permission for userManagement module
    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to view user passkeys.', 403);
    }

    const { userId } = req.params;

    const user = await User.findById(userId).select('+passkey');
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    let decryptedPasskey: string | null = null;
    if (user.passkey) {
      try {
        decryptedPasskey = decrypt(user.passkey);
      } catch (error) {
        logger.error(`Failed to decrypt passkey for user ${user.email}:`, error);
        decryptedPasskey = null;
      }
    }

    return successResponse(res, 'User passkey retrieved successfully', {
      hasPasskey: !!user.passkey,
      passkey: decryptedPasskey
    });
  } catch (error) {
    logger.error('Error getting user passkey:', error);
    return internalServerErrorResponse(res, 'Failed to get user passkey');
  }
};

// Update user's passkey (Admin only - for user management)
export const updateUserPasskey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;

    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user has managePermissions permission for userManagement module
    let hasManagePermissionsPerm = false;
    try {
      const userModulePerms = currentUser.permissions?.modules?.userManagement;
      if (userModulePerms && typeof userModulePerms === 'object' && userModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (userModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (userModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = userModulePerms as Record<string, unknown>;
        }
        hasManagePermissionsPerm = permsObj?.managePermissions === true;
      }
    } catch (permError) {
      logger.error('Error checking permissions:', permError);
    }

    if (!hasManagePermissionsPerm) {
      return errorResponse(res, 'Access denied. You don\'t have permission to update user passkeys.', 403);
    }

    const { userId } = req.params;
    const { newPasskey } = req.body;

    // Validate new passkey format
    if (!newPasskey || typeof newPasskey !== 'string') {
      return errorResponse(res, 'New passkey is required', 400);
    }

    if (newPasskey.length !== 6) {
      return errorResponse(res, 'Passkey must be exactly 6 digits', 400);
    }

    if (!/^\d{6}$/.test(newPasskey)) {
      return errorResponse(res, 'Passkey must contain only digits', 400);
    }

    const user = await User.findById(userId).select('+passkey');
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Admin can change passkey without knowing the current one
    // Encrypt and save new passkey
    user.passkey = encrypt(newPasskey);
    await user.save();

    try {
      const { AuditLog } = require('../models/AuditLog');
      await AuditLog.logSystemEvent({
        userId: currentUserId.toString(),
        action: 'user_passkey_updated_by_admin',
        metadata: {
          targetUserId: user._id.toString(),
          targetUserEmail: user.email,
          updatedBy: currentUser.displayName || currentUser.email
        }
      });
    } catch (auditError) {
      logger.error('Failed to log admin passkey update event:', auditError);
    }

    logger.info(`Passkey updated for user ${user.email} by admin ${currentUser.email}`);
    return successResponse(res, 'Passkey updated successfully');
  } catch (error) {
    logger.error('Error updating user passkey:', error);
    return internalServerErrorResponse(res, 'Failed to update user passkey');
  }
};

// Register/update the current user's chat encryption (NaCl box) public key —
// new endpoint for the chat E2E key-distribution upgrade (see encryptionService.ts
// and chatController.ts getGroupMemberKeys/rotateGroupKey). Self-service only;
// no permission gate beyond being authenticated as the user being updated.
export const updateEncryptionPublicKey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { encryptionPublicKey } = req.body;
    if (!isValidNaclPublicKeyB64(encryptionPublicKey)) {
      return errorResponse(res, 'encryptionPublicKey must be a valid base64-encoded 32-byte NaCl public key', 400);
    }

    await User.findByIdAndUpdate(userId, { encryptionPublicKey });
    return successResponse(res, 'Encryption public key updated');
  } catch (error) {
    logger.error('Error updating encryption public key:', error);
    return internalServerErrorResponse(res, 'Failed to update encryption public key');
  }
};