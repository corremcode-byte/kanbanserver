import { Request, Response } from 'express';
import { TaskTimeLog, Task, Project } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

// Log time for a task
export const logTime = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId, timeSpent, description, loggedAt } = req.body;

    if (!taskId || timeSpent === undefined) {
      return errorResponse(res, 'Task ID and time spent are required', 400);
    }

    if (timeSpent < 0) {
      return errorResponse(res, 'Time spent must be a positive number', 400);
    }

    // Find the task
    const task = await Task.findById(taskId);
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Check if user has access to this task
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is a member of the project
    const isMember = project.members.some((member: any) => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager: any) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;

    if (!isMember && !isManager && !isOwner) {
      return errorResponse(res, 'Access denied to this task', 403);
    }

    // For assignees, verify they are assigned to this task
    if (!isOwner && !isManager) {
      const isAssigned = task.assignees.some((assignee: any) => {
        const assigneeId = typeof assignee === 'object' && assignee._id
          ? assignee._id.toString()
          : assignee.toString();
        return assigneeId === req.user._id;
      });

      const isAssignedTo = task.assignedTo && task.assignedTo.toString() === req.user._id;

      if (!isAssigned && !isAssignedTo) {
        return errorResponse(res, 'You can only log time for tasks assigned to you', 403);
      }
    }

    // Create time log
    const timeLog = new TaskTimeLog({
      taskId,
      projectId: task.projectId,
      userId: req.user._id,
      timeSpent,
      description: description?.trim(),
      loggedAt: loggedAt ? new Date(loggedAt) : new Date()
    });

    await timeLog.save();
    await timeLog.populate('userId', 'displayName email photoURL');

    logger.info(`Time logged: ${timeSpent} minutes for task ${taskId} by ${req.user.email}`);

    return successResponse(res, 'Time logged successfully', timeLog);
  } catch (error) {
    logger.error('Error logging time:', error);
    return internalServerErrorResponse(res, 'Failed to log time');
  }
};

// Get time logs for a task
export const getTaskTimeLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId } = req.params;

    // Find the task
    const task = await Task.findById(taskId);
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Check if user has access to this task
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const isMember = project.members.some((member: any) => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager: any) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;

    if (!isMember && !isManager && !isOwner) {
      return errorResponse(res, 'Access denied to this task', 403);
    }

    const timeLogs = await TaskTimeLog.findByTask(taskId);
    const totalTime = await TaskTimeLog.getTotalTimeByTask(taskId);

    return successResponse(res, 'Time logs retrieved successfully', {
      timeLogs,
      totalTime
    });
  } catch (error) {
    logger.error('Error getting task time logs:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve time logs');
  }
};

// Get time logs for a project
export const getProjectTimeLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { startDate, endDate } = req.query;

    // Check if project exists and user has access
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const isMember = project.members.some((member: any) => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager: any) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;

    if (!isMember && !isManager && !isOwner) {
      return errorResponse(res, 'Access denied to this project', 403);
    }

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const timeLogs = await TaskTimeLog.findByProject(projectId, start, end);

    return successResponse(res, 'Time logs retrieved successfully', timeLogs);
  } catch (error) {
    logger.error('Error getting project time logs:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve time logs');
  }
};

// Get user's time logs
export const getUserTimeLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const timeLogs = await TaskTimeLog.findByUser(req.user._id, start, end);
    const totalTime = await TaskTimeLog.getTotalTimeByUser(req.user._id, start, end);

    return successResponse(res, 'Time logs retrieved successfully', {
      timeLogs,
      totalTime
    });
  } catch (error) {
    logger.error('Error getting user time logs:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve time logs');
  }
};

// Update time log
export const updateTimeLog = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { timeLogId } = req.params;
    const { timeSpent, description, loggedAt } = req.body;

    const timeLog = await TaskTimeLog.findById(timeLogId);
    if (!timeLog) {
      return notFoundResponse(res, 'Time log not found');
    }

    // Only the user who created the log can update it
    if (timeLog.userId.toString() !== req.user._id) {
      return errorResponse(res, 'You can only update your own time logs', 403);
    }

    if (timeSpent !== undefined) {
      if (timeSpent < 0) {
        return errorResponse(res, 'Time spent must be a positive number', 400);
      }
      timeLog.timeSpent = timeSpent;
    }

    if (description !== undefined) {
      timeLog.description = description.trim();
    }

    if (loggedAt) {
      timeLog.loggedAt = new Date(loggedAt);
    }

    await timeLog.save();
    await timeLog.populate('userId', 'displayName email photoURL');

    logger.info(`Time log ${timeLogId} updated by ${req.user.email}`);

    return successResponse(res, 'Time log updated successfully', timeLog);
  } catch (error) {
    logger.error('Error updating time log:', error);
    return internalServerErrorResponse(res, 'Failed to update time log');
  }
};

// Delete time log
export const deleteTimeLog = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { timeLogId } = req.params;

    const timeLog = await TaskTimeLog.findById(timeLogId);
    if (!timeLog) {
      return notFoundResponse(res, 'Time log not found');
    }

    // Only the user who created the log can delete it
    if (timeLog.userId.toString() !== req.user._id) {
      return errorResponse(res, 'You can only delete your own time logs', 403);
    }

    await TaskTimeLog.findByIdAndDelete(timeLogId);

    logger.info(`Time log ${timeLogId} deleted by ${req.user.email}`);

    return successResponse(res, 'Time log deleted successfully');
  } catch (error) {
    logger.error('Error deleting time log:', error);
    return internalServerErrorResponse(res, 'Failed to delete time log');
  }
};
