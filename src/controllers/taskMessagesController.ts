import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import TaskMessage from '../models/TaskMessage';
import Task from '../models/Task';
import Project from '../models/Project';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { getIO } from '../socket';
import { broadcastToProject, broadcastToUser } from '../socket/socketHandlers';
import { createNotification } from './notificationController';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

async function checkTaskAccess(task: any, userId: string): Promise<boolean> {
  if (!task.projectId) {
    const isCreator  = task.createdBy?.toString() === userId;
    const assigneeIds = Array.isArray(task.assignees)
      ? task.assignees.map((a: any) => (a?._id ? a._id : a).toString())
      : [];
    const isAssignee = assigneeIds.includes(userId);
    const isAssigner = task.assignedBy?.toString() === userId;
    return isCreator || isAssignee || isAssigner;
  }
  const project = await Project.findById(task.projectId);
  if (!project) return false;
  const ownerId  = project.ownerId.toString();
  const isMember  = project.members.some((m: any) => m.toString() === userId);
  const isManager = project.managers?.some((m: any) => m.toString() === userId) ?? false;
  return ownerId === userId || isMember || isManager;
}

export const getMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId } = req.params;
    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(taskId)) {
      return successResponse(res, 'Messages retrieved successfully', []);
    }

    const task = await Task.findById(taskId);
    if (!task) return notFoundResponse(res, 'Task not found');

    const userId = req.user!._id.toString();
    if (!(await checkTaskAccess(task, userId))) {
      return errorResponse(res, 'Access denied', 403);
    }

    const messages = await TaskMessage.find({ taskId })
      .populate('sentBy', 'displayName email avatar photoURL')
      .populate('mentions', 'displayName email')
      .sort({ createdAt: 1 });

    return successResponse(res, 'Messages retrieved successfully', messages);
  } catch (error) {
    logger.error('Error getting task messages:', error);
    return internalServerErrorResponse(res, 'Failed to get messages');
  }
};

export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId } = req.params;
    const { text, mentions = [] } = req.body;

    if (!text || !text.trim()) {
      return errorResponse(res, 'Message text is required', 400);
    }

    const { Types } = await import('mongoose');
    if (!Types.ObjectId.isValid(taskId)) {
      return notFoundResponse(res, 'Task not found');
    }

    const task = await Task.findById(taskId);
    if (!task) return notFoundResponse(res, 'Task not found');

    const userId = req.user!._id.toString();
    if (!(await checkTaskAccess(task, userId))) {
      return errorResponse(res, 'Access denied', 403);
    }

    const msg = await TaskMessage.create({
      taskId,
      text: text.trim(),
      sentBy: req.user!._id,
      mentions: Array.isArray(mentions)
        ? mentions.filter((id: string) => Types.ObjectId.isValid(id))
        : [],
    });

    const populated = await msg.populate([
      { path: 'sentBy',   select: 'displayName email avatar photoURL' },
      { path: 'mentions', select: 'displayName email' },
    ]);

    // Collect all participants (assignees + legacy assignedTo + createdBy + sender)
    const participantSet = new Set<string>([userId]); // always include sender so they see their own message
    if (Array.isArray(task.assignees)) {
      task.assignees.forEach((a: any) => {
        const id = (a?._id ? a._id : a).toString();
        if (id) participantSet.add(id);
      });
    }
    if (task.assignedTo) participantSet.add(task.assignedTo.toString());
    if (task.createdBy) participantSet.add((task.createdBy as any).toString());

    // Real-time broadcast to every participant's personal room
    const io = getIO();
    const msgPayload = { taskId, message: populated.toJSON(), timestamp: new Date() };
    participantSet.forEach(pid => broadcastToUser(io, pid, 'task:message', msgPayload));

    // Also broadcast to the project room so any other project members viewing the task get it
    if (task.projectId) {
      broadcastToProject(io, task.projectId.toString(), 'task:message', msgPayload);
    }

    // Collect recipients for notifications (exclude sender)
    const recipientSet = new Set<string>();
    if (Array.isArray(task.assignees)) {
      task.assignees.forEach((a: any) => {
        const id = (a?._id ? a._id : a).toString();
        if (id && id !== userId) recipientSet.add(id);
      });
    }
    if (task.assignedTo) {
      const id = task.assignedTo.toString();
      if (id !== userId) recipientSet.add(id);
    }
    if (task.createdBy) {
      const id = (task.createdBy as any).toString();
      if (id !== userId) recipientSet.add(id);
    }

    if (recipientSet.size > 0) {
      const shortText = text.trim().length > 80 ? text.trim().slice(0, 80) + '…' : text.trim();
      await Promise.all(Array.from(recipientSet).map((recipientId: string) =>
        createNotification({
          userId: recipientId,
          type: 'task_chat_message',
          title: `New message in "${task.title}"`,
          message: `${req.user!.displayName}: ${shortText}`,
          metadata: {
            taskId: task._id as any as string,
            taskTitle: task.title,
            projectId: task.projectId || undefined,
            messageId: msg._id as any as string,
            actionBy: req.user!._id,
            actionByName: req.user!.displayName,
          },
        }).catch(() => {})
      ));
    }

    return successResponse(res, 'Message sent successfully', populated);
  } catch (error) {
    logger.error('Error sending task message:', error);
    return internalServerErrorResponse(res, 'Failed to send message');
  }
};

export const deleteMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const msg = await TaskMessage.findById(messageId);
    if (!msg) return notFoundResponse(res, 'Message not found');

    if (msg.sentBy.toString() !== req.user!._id.toString()) {
      return errorResponse(res, 'Only the sender can delete this message', 403);
    }

    await msg.deleteOne();
    return successResponse(res, 'Message deleted successfully');
  } catch (error) {
    logger.error('Error deleting task message:', error);
    return internalServerErrorResponse(res, 'Failed to delete message');
  }
};
