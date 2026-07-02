import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import Task, { ITaskComment } from '../models/Task';
import Project from '../models/Project';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { AuditLog } from '../models/AuditLog';
import { getIO } from '../socket';
import { broadcastToProject } from '../socket/socketHandlers';
import { encryptField, decryptField } from '../utils/fieldEncryption';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

/**
 * Add a comment to a task
 * Any project member can comment
 */
export const addComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return errorResponse(res, 'Comment text is required', 400);
    }

    // Find task
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    const userId = req.user!._id.toString();

    // Standalone task (no project): allow creator/assignee/assigner to comment
    if (!task.projectId) {
      const isCreator = task.createdBy?.toString() === userId;
      const assigneeIds = Array.isArray(task.assignees)
        ? task.assignees.map((a: any) => a?._id ? a._id.toString() : a.toString())
        : [];
      const isAssignee = assigneeIds.includes(userId);
      const isAssigner = task.assignedBy?.toString() === userId;
      if (!isCreator && !isAssignee && !isAssigner) {
        return errorResponse(res, 'Access denied', 403);
      }
    } else {
      // Get project to verify permissions
      const project = await Project.findById(task.projectId);
      if (!project) {
        return notFoundResponse(res, 'Project not found');
      }
      const isOwner = project.ownerId.toString() === userId;
      const isMember = project.members.some((m: any) => m.toString() === userId);
      const isManager = project.managers?.some((m: any) => m.toString() === userId);
      if (!isOwner && !isMember && !isManager) {
        return errorResponse(res, 'Only project members can comment', 403);
      }
    }

    // Create comment (taskId here is the route param, same value as task._id)
    const comment = {
      id: uuidv4(),
      text: encryptField(text.trim(), taskId),
      createdBy: req.user!._id,
      createdAt: new Date()
    } as unknown as ITaskComment;

    // Add comment to task
    task.comments.push(comment);
    await task.save();

    // Populate the createdBy field for response
    await task.populate('comments.createdBy', 'displayName email avatar photoURL');

    // Find the created comment from the populated task and decrypt it once —
    // this same decrypted object is reused for both the broadcast and the response.
    const createdComment = task.comments.find((c: any) => c.id === comment.id);
    if (createdComment) createdComment.text = decryptField(createdComment.text, taskId);

    // Log audit action (commentText comes from the original request `text`, already plaintext)
    try {
      if (task.projectId) {
        await AuditLog.logAction({
          projectId: task.projectId.toString(),
          userId: req.user!._id,
          action: 'comment_added',
          entityType: 'task',
          entityId: task._id.toString(),
          metadata: {
            taskTitle: task.title,
            commentId: comment.id,
            commentText: text.substring(0, 100)
          }
        });
      }
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    // Broadcast to project room via socket (only for project tasks)
    if (task.projectId) {
      const io = getIO();
      broadcastToProject(io, task.projectId.toString(), 'comment:added', {
        taskId: task._id,
        comment: createdComment,
        createdBy: {
          id: req.user!._id,
          name: req.user!.displayName,
          email: req.user!.email
        },
        timestamp: new Date()
      });
    }

    logger.info(`Comment added to task ${task.title} by ${req.user!.displayName}`);

    return successResponse(res, 'Comment added successfully', createdComment);
  } catch (error) {
    logger.error('Error adding comment:', error);
    return internalServerErrorResponse(res, 'Failed to add comment');
  }
};

/**
 * Update a comment
 * Only the comment creator can update their comment
 */
export const updateComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId, commentId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return errorResponse(res, 'Comment text is required', 400);
    }

    // Find task
    const task = await Task.findById(taskId);
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Find comment
    const comment = task.comments.find((c: any) => c.id === commentId);
    if (!comment) {
      return notFoundResponse(res, 'Comment not found');
    }

    // Check if user is the comment creator
    const userId = req.user!._id.toString();
    if (comment.createdBy.toString() !== userId) {
      return errorResponse(res, 'Only the comment creator can update it', 403);
    }

    // Update comment
    comment.text = encryptField(text.trim(), taskId);
    comment.updatedAt = new Date();

    await task.save();
    await task.populate('comments.createdBy', 'displayName email avatar photoURL');

    // Decrypt once — this same object is reused for both the broadcast and the response.
    comment.text = decryptField(comment.text, taskId);

    // Log audit action
    try {
      await AuditLog.logAction({
        projectId: task.projectId.toString(),
        userId: req.user!._id,
        action: 'comment_updated',
        entityType: 'task',
        entityId: task._id.toString(),
        metadata: {
          taskTitle: task.title,
          commentId: comment.id
        }
      });
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, task.projectId.toString(), 'comment:updated', {
      taskId: task._id,
      comment,
      updatedBy: {
        id: req.user!._id,
        name: req.user!.displayName,
        email: req.user!.email
      },
      timestamp: new Date()
    });

    logger.info(`Comment updated on task ${task.title}`);

    const updatedComment = task.comments.find((c: any) => c.id === commentId);
    return successResponse(res, 'Comment updated successfully', updatedComment);
  } catch (error) {
    logger.error('Error updating comment:', error);
    return internalServerErrorResponse(res, 'Failed to update comment');
  }
};

/**
 * Delete a comment
 * Only project owner, admin, manager, or comment creator can delete
 */
export const deleteComment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId, commentId } = req.params;

    // Find task
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Find comment
    const comment = task.comments.find((c: any) => c.id === commentId);
    if (!comment) {
      return notFoundResponse(res, 'Comment not found');
    }

    const userId = req.user!._id.toString();
    const isCommentCreator = comment.createdBy.toString() === userId;

    if (!task.projectId) {
      // Standalone task: only comment creator can delete
      if (!isCommentCreator) {
        return errorResponse(res, 'Only the comment creator can delete this comment', 403);
      }
    } else {
      // Project task: owner, manager, or comment creator can delete
      const project = await Project.findById(task.projectId);
      if (!project) {
        return notFoundResponse(res, 'Project not found');
      }
      const isOwner = project.ownerId.toString() === userId;
      const isManager = project.managers?.some((m: any) => m.toString() === userId);
      if (!isOwner && !isManager && !isCommentCreator) {
        return errorResponse(res, 'Only project owner, manager, or comment creator can delete comments', 403);
      }
    }

    // Remove comment
    task.comments = task.comments.filter((c: any) => c.id !== commentId);
    await task.save();

    // Log audit action
    try {
      if (task.projectId) {
        await AuditLog.logAction({
          projectId: task.projectId.toString(),
          userId: req.user!._id,
          action: 'comment_deleted',
          entityType: 'task',
          entityId: task._id.toString(),
          metadata: {
            taskTitle: task.title,
            commentId: comment.id
          }
        });
      }
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    // Broadcast to project room via socket (only for project tasks)
    if (task.projectId) {
      const io = getIO();
      broadcastToProject(io, task.projectId.toString(), 'comment:deleted', {
        taskId: task._id,
        commentId,
        deletedBy: {
          id: req.user!._id,
          name: req.user!.displayName,
          email: req.user!.email
        },
        timestamp: new Date()
      });
    }

    logger.info(`Comment deleted from task ${task.title}`);
    return successResponse(res, 'Comment deleted successfully');
  } catch (error) {
    logger.error('Error deleting comment:', error);
    return internalServerErrorResponse(res, 'Failed to delete comment');
  }
};

/**
 * Get comment counts for multiple task IDs in one query
 */
export const getCommentCounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const raw = (req.query.ids as string) || '';
    const { Types } = await import('mongoose');
    const ids = raw.split(',').map(s => s.trim()).filter(id => Types.ObjectId.isValid(id));
    if (ids.length === 0) return successResponse(res, 'Comment counts retrieved', {});

    const tasks = await Task.find(
      { _id: { $in: ids } },
      { _id: 1, 'comments': 1 },
    ).lean();

    const counts: Record<string, number> = {};
    tasks.forEach((t: any) => {
      counts[t._id.toString()] = Array.isArray(t.comments) ? t.comments.length : 0;
    });

    return successResponse(res, 'Comment counts retrieved', counts);
  } catch (error) {
    logger.error('Error getting comment counts:', error);
    return internalServerErrorResponse(res, 'Failed to get comment counts');
  }
};

/**
 * Get all comments for a task
 */
export const getComments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId } = req.params;

    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(taskId)) {
      return successResponse(res, 'Comments retrieved successfully', []);
    }

    // Find task
    const task = await Task.findById(taskId)
      .populate('comments.createdBy', 'displayName email avatar photoURL');

    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    task.comments.forEach((c: any) => { if (c.text) c.text = decryptField(c.text, taskId); });

    // Standalone task (no project): allow creator/assignee/assigner.
    if (!task.projectId) {
      const requesterId = req.user!._id.toString();
      const isCreator = task.createdBy?.toString() === requesterId;
      const assigneeIds = Array.isArray(task.assignees)
        ? task.assignees.map((a: any) => a?._id ? a._id.toString() : a.toString())
        : [];
      const isAssignee = assigneeIds.includes(requesterId);
      const isAssigner = task.assignedBy?.toString() === requesterId;
      if (!isCreator && !isAssignee && !isAssigner) {
        return errorResponse(res, 'Access denied', 403);
      }
      const comments = task.comments.sort((a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      return successResponse(res, 'Comments retrieved successfully', comments);
    }

    // Get project to verify user has access
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user has access to this project
    const userId = req.user!._id.toString();
    const isOwner = project.ownerId.toString() === userId;
    const isMember = project.members.some((m: any) => m.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);

    if (!isOwner && !isMember && !isManager) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Sort comments by creation date (newest first)
    const comments = task.comments.sort((a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return successResponse(res, 'Comments retrieved successfully', comments);
  } catch (error) {
    logger.error('Error getting comments:', error);
    return internalServerErrorResponse(res, 'Failed to get comments');
  }
};
