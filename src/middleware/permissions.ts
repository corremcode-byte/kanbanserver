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

      // Owners always have all permissions
      if (isOwner || isInOwners) {
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

    // Check if user is assigned to this task
    const isAssigned = task.assignees && task.assignees.some((assignee: any) => {
      const assigneeId = typeof assignee === 'object' && assignee._id
        ? assignee._id.toString()
        : assignee.toString();
      return assigneeId === userId;
    });

    console.log('Task edit permission check:', {
      taskId: task._id,
      userId,
      isOwner,
      isInOwners,
      isAssigned,
      assignees: task.assignees,
      taskTitle: task.title
    });

    // If user is assigned to the task, they can always update status and basic fields
    if (isAssigned) {
      console.log('User is assigned - allowing edit');
      return next();
    }

    // Check user's permissions for non-assigned users
    const userPermission = await ProjectPermission.findOne({
      projectId,
      userId
    });

    if (!userPermission) {
      return errorResponse(res, 'You are not a member of this project', 403);
    }

    // Check if user has canEditTasks permission
    if (!userPermission.permissions.canEditTasks) {
      return errorResponse(res, 'You don\'t have permission to edit tasks', 403);
    }

    // If user has canViewAllTasks, they can edit any task
    if (userPermission.permissions.canViewAllTasks) {
      return next();
    }

    // User has canEditTasks but not canViewAllTasks and not assigned
    return errorResponse(res, 'You can only edit tasks assigned to you', 403);
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
 * Legacy function - kept for backwards compatibility
 */
export const checkTaskAccess = checkCanEditTask;
