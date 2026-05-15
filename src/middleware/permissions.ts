import { Request, Response, NextFunction } from 'express';
import { ProjectPermission, Project, Task } from '../models';
import { errorResponse } from '../utils/responses';

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

type Permission =
  | 'canCreateTasks'
  | 'canEditTasks'
  | 'canDeleteTasks'
  | 'canAssignTasks'
  | 'canEditProject'
  | 'canManageMembers'
  | 'canViewAllTasks'
  | 'canManagePermissions'
  | 'canCreateChatGroups'
  | 'canDeleteChatGroups';

/**
 * Middleware to check if user has specific permission for a project
 * Usage: checkPermission('canCreateTasks')
 */
export const checkPermission = (permission: Permission) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return errorResponse(res, 'Unauthorized', 401);
      }

      // Get projectId from various sources
      let projectId: string | undefined;

      // 1. From route params (check both projectId and id)
      projectId = req.params.projectId || req.params.id;

      // 2. From request body
      if (!projectId && req.body.projectId) {
        projectId = req.body.projectId;
      }

      // 3. From task (if updating/deleting a task and not a project route)
      if (!projectId) {
        if (permission === 'canCreateTasks') {
          // Support creating standalone tasks (without project) when global permission exists.
          const User = (await import('../models/User')).User;
          const user = await User.findById(userId);
          if (user?.permissions?.canCreateTasks === true || user?.permissions?.canManageAllProjects === true) {
            return next();
          }
        }
        return errorResponse(res, 'Project ID not found', 400);
      }

      // Verify if projectId is a task ID, and if so, get the project from the task
      const task = await Task.findById(projectId);
      if (task) {
        projectId = task.projectId.toString();
      }

      if (!projectId) {
        return errorResponse(res, 'Project ID not found', 400);
      }

      // Check if user is project owner
      const project = await Project.findById(projectId);
      if (!project) {
        return errorResponse(res, 'Project not found', 404);
      }

      const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
        ? (project.ownerId as any)._id.toString()
        : project.ownerId.toString();

      const isOwner = ownerId === userId;
      const isInOwners = project.owners && project.owners.some((owner: any) => {
        const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
        return owId === userId;
      });

      // Main owner always has all permissions
      if (isOwner) {
        return next();
      }

      // Co-owner permission model:
      // - edit: can manage project-level operations
      // - view: does not get owner management powers
      if (isInOwners) {
        const coOwnerPermissions = project.coOwnerPermissions as Map<string, 'view' | 'edit'> | Record<string, 'view' | 'edit'> | undefined;
        let coOwnerPermission: 'view' | 'edit' = 'edit';

        if (coOwnerPermissions) {
          if (typeof (coOwnerPermissions as Map<string, 'view' | 'edit'>).get === 'function') {
            coOwnerPermission = (coOwnerPermissions as Map<string, 'view' | 'edit'>).get(userId) || 'edit';
          } else {
            coOwnerPermission = (coOwnerPermissions as Record<string, 'view' | 'edit'>)[userId] || 'edit';
          }
        }

        if (coOwnerPermission === 'edit') {
          return next();
        }
      }

      // Check global permissions first (for users with manage all projects permission)
      const User = (await import('../models/User')).User;
      const user = await User.findById(userId);

      // If user has global canManageAllProjects permission, allow all project operations
      if (user?.permissions?.canManageAllProjects === true) {
        return next();
      }

      // Check specific global task permissions
      if (permission === 'canCreateTasks' && user?.permissions?.canCreateTasks === true) {
        return next();
      }
      if (permission === 'canAssignTasks' && user?.permissions?.canAssignTasks === true) {
        return next();
      }

      // Check module-based project permissions for canManageMembers
      if (permission === 'canManageMembers') {
        // If global manageMembers is explicitly FALSE, deny immediately
        if (user?.permissions?.modules?.projects?.manageMembers === false) {
          return errorResponse(res, 'You don\'t have permission to manage members', 403);
        }
        // If global manageMembers is TRUE, allow
        if (user?.permissions?.modules?.projects?.manageMembers === true) {
          return next();
        }
        // If global manageMembers is undefined (not set), deny access
        // User must have explicit global permission to manage members
        return errorResponse(res, 'You don\'t have permission to manage members. This permission must be granted in your user permissions.', 403);
      }

      // Check user's project-level permissions
      const userPermission = await ProjectPermission.findOne({
        projectId,
        userId
      });

      if (!userPermission) {
        return errorResponse(res, 'You are not a member of this project', 403);
      }

      // Check if user has the required permission
      if (!userPermission.permissions[permission]) {
        return errorResponse(res, `You don't have permission to ${permission.replace('can', '').toLowerCase()}`, 403);
      }

      next();
    } catch (error) {
      console.error('Permission middleware error:', error);
      return errorResponse(res, 'Permission check failed', 500);
    }
  };
};

/**
 * Middleware to check if user can edit a task
 * Checks canEditTasks permission and task ownership
 */
export const checkCanEditTask = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const taskId = req.params.id;

    if (!userId || !taskId) {
      return errorResponse(res, 'Invalid request', 400);
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return errorResponse(res, 'Task not found', 404);
    }

    // Standalone task (no project): allow creator/assignee or users with global edit permission.
    if (!task.projectId) {
      const User = (await import('../models/User')).User;
      const user = await User.findById(userId);
      const isCreator = task.createdBy?.toString() === userId;
      const isAssigned = (Array.isArray(task.assignees) && task.assignees.some((assignee: any) => {
        const assigneeId = typeof assignee === 'object' && assignee._id
          ? assignee._id.toString()
          : assignee.toString();
        return assigneeId === userId;
      })) || task.assignedTo?.toString() === userId;
      const isAssignedBy = task.assignedBy?.toString() === userId;
      if (user?.permissions?.canEditTasks === true || isCreator || isAssigned || isAssignedBy) {
        return next();
      }
      return errorResponse(res, 'You don\'t have permission to edit this task', 403);
    }

    const projectId = task.projectId.toString();

    // Check if user is project owner
    const project = await Project.findById(projectId);
    if (!project) {
      return errorResponse(res, 'Project not found', 404);
    }

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === userId;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === userId;
    });

    // Owners can edit any task
    if (isOwner || isInOwners) {
      return next();
    }

    // Check global permissions
    const User = (await import('../models/User')).User;
    const user = await User.findById(userId);
    if (user?.permissions?.canEditTasks === true) {
      return next();
    }

    // Check if user is assigned to or assigned this task
    const isAssigned = task.assignees && task.assignees.some((assignee: any) => {
      const assigneeId = typeof assignee === 'object' && assignee._id
        ? assignee._id.toString()
        : assignee.toString();
      return assigneeId === userId;
    }) || task.assignedTo?.toString() === userId;

    const isAssignedBy = task.assignedBy?.toString() === userId ||
                         task.createdBy?.toString() === userId;

    // Assignee or the person who assigned the task can always edit
    if (isAssigned || isAssignedBy) {
      return next();
    }

    // Check project-level permissions for everyone else
    const userPermission = await ProjectPermission.findOne({ projectId, userId });

    if (!userPermission) {
      return errorResponse(res, 'You are not a member of this project', 403);
    }

    // Any project member with canEditTasks permission can edit
    if (userPermission.permissions.canEditTasks) {
      return next();
    }

    return errorResponse(res, 'You don\'t have permission to edit tasks in this project', 403);
  } catch (error) {
    console.error('Task edit check error:', error);
    return errorResponse(res, 'Permission check failed', 500);
  }
};

/**
 * Middleware to check if user can delete a task
 */
export const checkCanDeleteTask = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const taskId = req.params.id;

    if (!userId || !taskId) {
      return errorResponse(res, 'Invalid request', 400);
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return errorResponse(res, 'Task not found', 404);
    }

    // Standalone task (no project): allow creator or users with global delete permission.
    if (!task.projectId) {
      const User = (await import('../models/User')).User;
      const user = await User.findById(userId);
      const isCreator = task.createdBy?.toString() === userId;
      if (user?.permissions?.canDeleteTasks === true || isCreator) {
        return next();
      }
      return errorResponse(res, 'You don\'t have permission to delete this task', 403);
    }

    const projectId = task.projectId.toString();

    // Check if user is project owner
    const project = await Project.findById(projectId);
    if (!project) {
      return errorResponse(res, 'Project not found', 404);
    }

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === userId;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === userId;
    });

    // Owners can delete any task
    if (isOwner || isInOwners) {
      return next();
    }

    // Check global permissions
    const User = (await import('../models/User')).User;
    const user = await User.findById(userId);
    if (user?.permissions?.canDeleteTasks === true) {
      return next();
    }

    // Check user's permissions
    const userPermission = await ProjectPermission.findOne({
      projectId,
      userId
    });

    if (!userPermission) {
      return errorResponse(res, 'You are not a member of this project', 403);
    }

    // Must have canDeleteTasks permission
    if (!userPermission.permissions.canDeleteTasks) {
      return errorResponse(res, 'You don\'t have permission to delete tasks', 403);
    }

    next();
  } catch (error) {
    console.error('Task delete check error:', error);
    return errorResponse(res, 'Permission check failed', 500);
  }
};

/**
 * Middleware to check if user can create projects (global permission)
 */
export const checkCanCreateProject = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return errorResponse(res, 'Unauthorized', 401);
    }

    // Get user's global permissions
    const User = (await import('../models/User')).User;
    const user = await User.findById(userId);

    // Handle different boolean representations (true, "true", 1, etc.)
    const isPersonal = req.body.isPersonal === true || 
                      req.body.isPersonal === 'true' || 
                      req.body.isPersonal === 1 ||
                      String(req.body.isPersonal).toLowerCase() === 'true';
    // Note: Admin/manager role no longer bypasses permission checks.
    // All users must have explicit permissions granted.

    // If creating a personal project, check personal project permission FIRST
    if (isPersonal) {
      // Check global canCreatePersonalProjects permission
      if (user && user.permissions && user.permissions.canCreatePersonalProjects === true) {
        return next();
      }
      
      // Check module-level personalProjects permission
      const hasModulePersonalProjects = user?.permissions?.modules?.projects?.personalProjects === true;
      if (hasModulePersonalProjects) {
        return next();
      }
      
      // Do NOT allow canCreateProjects to create personal projects
      // Personal projects require explicit personalProjects permission
      return errorResponse(res, 'You don\'t have permission to create personal projects. This permission must be explicitly granted.', 403);
    }

    // For regular (non-personal) projects, check canCreateProjects permission
    if (user && user.permissions && user.permissions.canCreateProjects === true) {
      return next();
    }

    // If no global permission, deny by default (user needs the permission to create projects)
    return errorResponse(res, 'You don\'t have permission to create projects', 403);
  } catch (error) {
    console.error('Create project check error:', error);
    return errorResponse(res, 'Permission check failed', 500);
  }
};

/**
 * Middleware to check if user can delete projects (owner or global permission)
 */
export const checkCanDeleteProject = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const projectId = req.params.id;

    if (!userId || !projectId) {
      return errorResponse(res, 'Invalid request', 400);
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return errorResponse(res, 'Project not found', 404);
    }

    // Check if user is project owner
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === userId;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === userId;
    });
    // Only main/original owner can delete project
    if (isOwner) {
      return next();
    }

    // Get user's global permissions
    const User = (await import('../models/User')).User;
    const user = await User.findById(userId);

    // Check if user has global permission to delete any project (admin feature)
    if (user && user.permissions && user.permissions.canDeleteProjects === true) {
      return next();
    }

    return errorResponse(res, 'You don\'t have permission to delete this project', 403);
  } catch (error) {
    console.error('❌ Delete project check error:', error);
    return errorResponse(res, 'Permission check failed', 500);
  }
};

/**
 * Legacy function - kept for backwards compatibility
 */
export const checkTaskAccess = checkCanEditTask;
