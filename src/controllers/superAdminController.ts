import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/auth';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import User from '../models/User';
import Task from '../models/Task';
import Project from '../models/Project';
import Note from '../models/Note';
import ChatGroup from '../models/ChatGroup';

export const getAdminUserModuleData = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { module } = req.query as { module?: string };

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const user = await User.findById(userId);
    if (!user) return errorResponse(res, 'User not found', 404);

    const uid = new mongoose.Types.ObjectId(userId);

    switch (module) {
      case 'dashboard': {
        const [assigned, completed, created, overdue] = await Promise.all([
          Task.countDocuments({ isDeleted: { $ne: true }, $or: [{ assigneeId: uid }, { assignedTo: uid }, { assignees: uid }] }),
          Task.countDocuments({ isDeleted: { $ne: true }, status: 'done', $or: [{ assigneeId: uid }, { assignedTo: uid }, { assignees: uid }] }),
          Task.countDocuments({ isDeleted: { $ne: true }, createdBy: uid }),
          Task.countDocuments({ isDeleted: { $ne: true }, dueDate: { $lt: new Date() }, status: { $ne: 'done' }, $or: [{ assigneeId: uid }, { assignedTo: uid }, { assignees: uid }] }),
        ]);
        return successResponse(res, 'OK', { assigned, completed, created, overdue, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt });
      }

      case 'tasks': {
        const tasks = await Task.find({
          isDeleted: { $ne: true },
          $or: [{ assigneeId: uid }, { assignedTo: uid }, { assignees: uid }, { createdBy: uid }],
        })
          .sort({ updatedAt: -1 })
          .limit(50)
          .select('title status priority dueDate createdBy assignees')
          .populate('createdBy', 'displayName')
          .lean();
        return successResponse(res, 'OK', { tasks });
      }

      case 'projects': {
        const projects = await Project.find({
          $or: [{ ownerId: uid }, { owners: uid }, { members: uid }],
        })
          .sort({ updatedAt: -1 })
          .limit(50)
          .select('name description status ownerId owners members createdAt')
          .populate('ownerId', 'displayName')
          .lean();
        return successResponse(res, 'OK', { projects });
      }

      case 'notes': {
        const notes = await Note.find({
          $or: [{ userId: uid }, { sharedWith: { $elemMatch: { userId: uid } } }],
        })
          .sort({ updatedAt: -1 })
          .limit(50)
          .select('title content updatedAt userId')
          .lean();
        return successResponse(res, 'OK', { notes });
      }

      case 'chats': {
        const groups = await ChatGroup.find({ members: uid })
          .sort({ updatedAt: -1 })
          .limit(50)
          .select('name description members createdAt')
          .populate('members', 'displayName photoURL')
          .lean();
        return successResponse(res, 'OK', { groups });
      }

      default:
        return errorResponse(res, 'Invalid module', 400);
    }
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to fetch module data');
  }
};
