import { Request, Response } from 'express';
import { ProjectPermission, Project, User, AuditLog } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
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
}

// Get all permissions for a project (owner only)
export const getProjectPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner or has canManagePermissions
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // If not owner, check if user has canManagePermissions
    if (!isOwner && !isInOwners) {
      const userPermission = await ProjectPermission.findOne({
        projectId,
        userId: req.user._id
      });

      if (!userPermission || !userPermission.permissions.canManagePermissions) {
        return errorResponse(res, 'You do not have permission to manage permissions', 403);
      }
    }

    // Get all permissions for the project
    const permissions = await ProjectPermission.find({ projectId })
      .populate('userId', 'displayName email photoURL role')
      .sort({ createdAt: -1 });

    // Filter out permissions with null userId (deleted users)
    const validPermissions = permissions.filter(p => p.userId != null);
    const normalizedPermissions = validPermissions.map((p) => {
      const defaults = ProjectPermission.getDefaultPermissions(p.role);
      return {
        ...p.toJSON(),
        permissions: { ...defaults, ...p.permissions }
      };
    });

    return successResponse(res, 'Permissions retrieved successfully', normalizedPermissions);
  } catch (error) {
    logger.error('Error getting project permissions:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve permissions');
  }
};

// Get user's permission for a project
export const getUserPermission = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Get permission
    const permission = await ProjectPermission.findOne({ projectId, userId })
      .populate('userId', 'displayName email photoURL role');

    if (!permission) {
      return notFoundResponse(res, 'Permission not found');
    }

    // Normalize permissions with defaults to ensure all fields are present
    const defaults = ProjectPermission.getDefaultPermissions(permission.role);
    const normalizedPermission = {
      ...permission.toJSON(),
      permissions: { ...defaults, ...permission.permissions }
    };

    return successResponse(res, 'Permission retrieved successfully', normalizedPermission);
  } catch (error) {
    logger.error('Error getting user permission:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve permission');
  }
};

// Update user permissions (owner only)
export const updateUserPermission = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;
    const { permissions, role } = req.body;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // If not owner, check if user has canManagePermissions
    if (!isOwner && !isInOwners) {
      const userPermission = await ProjectPermission.findOne({
        projectId,
        userId: req.user._id
      });

      if (!userPermission || !userPermission.permissions.canManagePermissions) {
        return errorResponse(res, 'You do not have permission to manage permissions', 403);
      }
    }

    // Cannot change owner permissions
    if (userId === ownerId) {
      return errorResponse(res, 'Cannot change owner permissions', 400);
    }

    // Find or create permission
    let permission = await ProjectPermission.findOne({ projectId, userId });

    if (!permission) {
      // Create new permission
      const defaultPerms = ProjectPermission.getDefaultPermissions(role || 'assignee');
      const mergedPermissions = permissions ? { ...defaultPerms, ...permissions } : defaultPerms;
      
      permission = new ProjectPermission({
        projectId,
        userId,
        role: role || 'assignee',
        permissions: mergedPermissions
      });
    } else {
      // Update existing permission
      if (permissions) {
        // Get default permissions for current role (or new role if changing)
        const targetRole = role || permission.role;
        const defaultPerms = ProjectPermission.getDefaultPermissions(targetRole);
        
        // Merge defaults with provided permissions to ensure all fields are present
        const mergedPermissions = { ...defaultPerms, ...permissions };
        
        // Explicitly set each permission to ensure false values are saved
        Object.keys(mergedPermissions).forEach(key => {
          permission.permissions[key as keyof typeof permission.permissions] = mergedPermissions[key as keyof typeof mergedPermissions];
        });
        // Mark the permissions field as modified for Mongoose
        permission.markModified('permissions');
      }
      if (role && role !== permission.role) {
        permission.role = role;
        // Update role in project arrays
        if (role === 'manager') {
          if (!project.managers) {
            project.managers = [];
          }
          if (!project.managers.some(m => m.toString() === userId)) {
            project.managers.push(userId as any);
          }
        } else {
          // Remove from managers if downgraded to assignee
          if (project.managers) {
            project.managers = project.managers.filter(m => m.toString() !== userId);
          }
        }
        await project.save();
      }
    }

    await permission.save();

    // Log permission change
    try {
      await AuditLog.logAction({
        projectId: projectId,
        userId: req.user._id,
        action: 'permission_changed',
        entityType: 'permission',
        entityId: userId,
        metadata: {
          targetUserId: userId,
          newRole: role || permission.role,
          newPermissions: permission.permissions
        }
      });
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    await permission.populate('userId', 'displayName email photoURL role');

    // Normalize permissions with defaults to ensure all fields are present in response
    const defaults = ProjectPermission.getDefaultPermissions(permission.role);
    const normalizedPermission = {
      ...permission.toJSON(),
      permissions: { ...defaults, ...permission.permissions }
    };

    return successResponse(res, 'Permission updated successfully', normalizedPermission);
  } catch (error) {
    logger.error('Error updating user permission:', error);
    return internalServerErrorResponse(res, 'Failed to update permission');
  }
};

// Delete user permission (owner only) - also removes user from project
export const deleteUserPermission = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // If not owner, check if user has canManagePermissions
    if (!isOwner && !isInOwners) {
      const userPermission = await ProjectPermission.findOne({
        projectId,
        userId: req.user._id
      });

      if (!userPermission || !userPermission.permissions.canManagePermissions) {
        return errorResponse(res, 'You do not have permission to manage permissions', 403);
      }
    }

    // Cannot remove owner
    if (userId === ownerId) {
      return errorResponse(res, 'Cannot remove owner from project', 400);
    }

    // Delete permission
    await ProjectPermission.findOneAndDelete({ projectId, userId });

    // Remove user from project members and managers
    project.members = project.members.filter(m => m.toString() !== userId);
    if (project.managers) {
      project.managers = project.managers.filter(m => m.toString() !== userId);
    }
    await project.save();

    // Log member removal
    try {
      await AuditLog.logAction({
        projectId: projectId,
        userId: req.user._id,
        action: 'member_removed',
        entityType: 'member',
        entityId: userId,
        metadata: {
          removedUserId: userId
        }
      });
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    return successResponse(res, 'Permission deleted successfully');
  } catch (error) {
    logger.error('Error deleting user permission:', error);
    return internalServerErrorResponse(res, 'Failed to delete permission');
  }
};

// Get my permissions for a project
export const getMyPermission = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner (owners have all permissions)
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;

    if (isOwner) {
      // Return owner permissions
      return successResponse(res, 'Permission retrieved successfully', {
        role: 'owner',
        permissions: ProjectPermission.getDefaultPermissions('owner'),
        isOwner: true
      });
    }

    // Get permission from database
    const permission = await ProjectPermission.findOne({
      projectId,
      userId: req.user._id
    });

    if (!permission) {
      return notFoundResponse(res, 'Permission not found. You may not be a member of this project.');
    }

    const defaults = ProjectPermission.getDefaultPermissions(permission.role);

    return successResponse(res, 'Permission retrieved successfully', {
      ...permission.toJSON(),
      permissions: { ...defaults, ...permission.permissions },
      isOwner: false
    });
  } catch (error) {
    logger.error('Error getting my permission:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve permission');
  }
};
