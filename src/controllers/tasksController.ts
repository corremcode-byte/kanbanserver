import { Request, Response } from 'express';
import { Task, Project } from '../models';
import { AuditLog, IAuditLog } from '../models/AuditLog';
import { ProjectPermission } from '../models/ProjectPermission';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { getIO } from '../socket';
import { broadcastToProject, broadcastToUser } from '../socket/socketHandlers';
import { emailService } from '../services/emailService';
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

/** Embedded subtasks: require non-empty title; assignee optional but must be owner/member/manager when set. */
function normalizeEmbeddedSubtasks(subtasks: unknown, validAssigneeIds: string[]) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .filter(
      (subtask: any) =>
        subtask &&
        typeof subtask.title === 'string' &&
        subtask.title.trim()
    )
    .map((subtask: any) => {
      const rawAssignee = subtask.assigneeId ? String(subtask.assigneeId) : undefined;
      const assigneeId =
        rawAssignee && validAssigneeIds.includes(rawAssignee) ? rawAssignee : undefined;
      return {
        id: subtask.id || `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: subtask.title.trim(),
        description: subtask.description?.trim() || undefined,
        completed: Boolean(subtask.completed),
        status: subtask.status || (subtask.completed ? 'completed' : 'todo'),
        priority: subtask.priority || 'medium',
        assigneeId,
        dueDate: subtask.dueDate ? new Date(subtask.dueDate) : undefined,
        reminderFrequency: subtask.reminderFrequency || 'none',
        customReminderMinutes:
          subtask.reminderFrequency === 'custom'
            ? Number(subtask.customReminderMinutes || 1)
            : undefined,
        linkedTaskId: subtask.linkedTaskId || undefined
      };
    });
}

export const getTasks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.query;

    let tasks;

    // If projectId provided ➜ validate permissions & fetch within that project
    if (projectId) {
      // Check if user has access to the project
      const project = await Project.findById(projectId);
      if (!project) {
        return notFoundResponse(res, 'Project not found');
      }

    // Check if user is a member, manager, or owner of the project
    // Handle populated owner object vs plain ObjectId
    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
      ? project.ownerId._id.toString()
      : project.ownerId.toString();

    const isMember = project.members.some((member) => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const isCoOwner = project.owners && project.owners.some((owner) => {
      const ownerObj = owner as unknown as { _id?: { toString(): string }; toString(): string };
      const coOwnerId = ownerObj._id ? ownerObj._id.toString() : ownerObj.toString();
      return coOwnerId === req.user._id;
    });

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager || isCoOwner;

      if (!isOwnerOrMemberOrManager) {
        return errorResponse(res, 'Access denied to this project', 403);
      }

      // Check if user has canViewAllTasks permission
      const isOwner = ownerId === req.user._id;
      // Co-owners always have full task visibility regardless of permission level
      let canViewAllTasks = isOwner || isCoOwner;

      if (!isOwner && !isCoOwner) {
        // Check user's permissions
        const userPermission = await ProjectPermission.findOne({
          projectId,
          userId: req.user._id
        });

        canViewAllTasks = userPermission?.permissions?.canViewAllTasks || false;
      }

      // Fetch tasks based on permission
      if (canViewAllTasks) {
        // Can view all tasks in the project
        tasks = await Task.find({
          projectId,
          isSubtask: { $ne: true },
        }).populate('projectId', 'name')
          .populate('assignees', 'displayName email avatar photoURL')
          .populate('assignedTo', 'displayName email avatar photoURL')
          .populate('assignedBy', 'displayName email avatar photoURL')
          .sort({ createdAt: -1 }); // Newest first
      } else {
        // Can only view tasks assigned to them or created by them
        tasks = await Task.find({
          projectId,
          isSubtask: { $ne: true },
          $or: [
            { assignedTo: req.user._id },
            { assignees: req.user._id },
            { assignedBy: req.user._id }
          ]
        }).populate('projectId', 'name')
          .populate('assignees', 'displayName email avatar photoURL')
          .populate('assignedTo', 'displayName email avatar photoURL')
          .populate('assignedBy', 'displayName email avatar photoURL')
          .sort({ createdAt: -1 }); // Newest first
      }
    } else {
      // No projectId ➜ fetch tasks based on user's role and permissions
      // Find all projects where user is owner, member, or manager
      const userProjects = await Project.find({
        $or: [
          { ownerId: req.user._id },
          { members: req.user._id },
          { managers: req.user._id },
          { owners: req.user._id }
        ]
      }).select('_id ownerId');

      const projectIds = userProjects.map(p => p._id);

      // For managers/owners/co-owners: show ALL tasks in their projects
      const managedProjectIds = userProjects
        .filter(p => p.ownerId.toString() === req.user._id.toString())
        .map(p => p._id);

      // Also include projects where user is a manager or co-owner
      const managerProjects = await Project.find({
        $or: [
          { managers: req.user._id },
          { owners: req.user._id }
        ]
      }).select('_id');

      managedProjectIds.push(...managerProjects.map(p => p._id));

      // Check for projects where user has canViewAllTasks permission
      const permissionsWithViewAll = await ProjectPermission.find({
        userId: req.user._id,
        projectId: { $in: projectIds },
        'permissions.canViewAllTasks': true
      }).select('projectId');

      const viewAllTasksProjectIds = permissionsWithViewAll.map(p => p.projectId);

      // Combine managed projects and projects with canViewAllTasks permission
      const allAccessProjectIds = [
        ...managedProjectIds,
        ...viewAllTasksProjectIds
      ];

      tasks = await Task.find({
        isSubtask: { $ne: true },
        $or: [
          // Tasks assigned to the user
          { assignedTo: req.user._id },
          { assignees: req.user._id },
          // Tasks created by the user
          { assignedBy: req.user._id },
          // ALL tasks from projects where user is owner, manager, or has canViewAllTasks permission
          { projectId: { $in: allAccessProjectIds } }
        ]
      }).populate('projectId', 'name')
        .populate('assignees', 'displayName email avatar photoURL')
        .populate('assignedTo', 'displayName email avatar photoURL')
        .populate('assignedBy', 'displayName email avatar photoURL')
        .sort({ createdAt: -1 }); // Newest first
    }

    return successResponse(res, 'Tasks retrieved successfully', tasks);
  } catch (error) {
    logger.error('Error getting tasks:', error);
    return internalServerErrorResponse(res, 'Failed to fetch tasks');
  }
};

export const getTask = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const task = await Task.findById(id)
      .populate('projectId', 'name')
      .populate('assignees', 'displayName email avatar photoURL')
      .populate('assignedTo', 'displayName email avatar photoURL')
      .populate('assignedBy', 'displayName email avatar photoURL');

    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Standalone task (no project): allow creator/assignee/assigner to view.
    if (!task.projectId) {
      const requesterId = req.user._id.toString();
      const isCreator = task.createdBy?.toString() === requesterId;
      const assigneeIds = Array.isArray(task.assignees)
        ? task.assignees.map((a: any) => a?._id ? a._id.toString() : a.toString())
        : [];
      const isAssignee = assigneeIds.includes(requesterId);
      const isAssigner = task.assignedBy
        ? (typeof task.assignedBy === 'object' && (task.assignedBy as any)._id
            ? (task.assignedBy as any)._id.toString()
            : task.assignedBy.toString()) === requesterId
        : false;

      if (!isCreator && !isAssignee && !isAssigner) {
        return errorResponse(res, 'Access denied to this task', 403);
      }
      return successResponse(res, 'Task retrieved successfully', task);
    }

    // Check if user has access to the project this task belongs to
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
      ? project.ownerId._id.toString()
      : project.ownerId.toString();

    const isMember = project.members.some(member => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager;

    if (!isOwnerOrMemberOrManager) {
      return errorResponse(res, 'Access denied to this task', 403);
    }

    return successResponse(res, 'Task retrieved successfully', task);
  } catch (error) {
    logger.error('Error getting task:', error);
    return internalServerErrorResponse(res, 'Failed to fetch task');
  }
};

export const createTask = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, assignedTo, assignees, status, listId, priority, dueDate, reminderFrequency, customReminderMinutes, reminderStartTime, reminderEndTime, subtasks, isSubtask, parentTaskId } = req.body;
    const rawProjectId = req.body?.projectId;
    const normalizedProjectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : rawProjectId;
    const projectId = (
      normalizedProjectId &&
      normalizedProjectId !== '__NO_PROJECT__' &&
      normalizedProjectId !== 'undefined' &&
      normalizedProjectId !== 'null'
    ) ? normalizedProjectId : undefined;
    if (reminderFrequency !== undefined) {
      const validFrequencies = ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'];
      if (!validFrequencies.includes(reminderFrequency)) {
        return errorResponse(res, 'Invalid reminder frequency', 400);
      }
      if (reminderFrequency === 'custom') {
        const customMinutes = Number(customReminderMinutes);
        if (!Number.isFinite(customMinutes) || customMinutes < 1) {
          return errorResponse(res, 'Custom reminder minutes must be at least 1', 400);
        }
      }
    }

    if (!title?.trim()) {
      return errorResponse(res, 'Task title is required', 400);
    }

    if (!dueDate) {
      return errorResponse(res, 'Due date is required', 400);
    }

    let project = null;
    let validatedListId = listId || status || 'todo';
    let allValidUserIds: string[] = [];
    let ownerId = req.user._id.toString();

    if (projectId) {
      // Check if project exists and user has access
      project = await Project.findById(projectId);
      if (!project) {
        return notFoundResponse(res, 'Project not found');
      }

      // Validate listId if provided - check if it exists in project's columns
      if (project.columns && project.columns.length > 0) {
        const listExists = project.columns.some(col => col.id === validatedListId);
        if (!listExists) {
          // If provided listId doesn't exist, use the first column
          validatedListId = project.columns[0].id;
        }
      }

      // Check if user is a member, manager, or owner of the project
      ownerId = typeof project.ownerId === 'object' && project.ownerId._id
        ? project.ownerId._id.toString()
        : project.ownerId.toString();

      const isMember = project.members.some(member => {
        const memberId = typeof member === 'object' && member._id
          ? member._id.toString()
          : member.toString();
        return memberId === req.user._id;
      });

      const isManager = project.managers && project.managers.some((manager) => {
        const managerId = typeof manager === 'object' && manager._id
          ? manager._id.toString()
          : manager.toString();
        return managerId === req.user._id;
      });

      const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager;

      if (!isOwnerOrMemberOrManager) {
        return errorResponse(res, 'Access denied to this project', 403);
      }

      // Get all valid project member, manager, and owner IDs
      const projectMemberIds = project.members.map(m => m.toString());
      const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
      allValidUserIds = [...new Set([...projectMemberIds, ...projectManagerIds, ownerId])];
    } else {
      // Without project, only validate that users are unique IDs and include self for subtasks.
      allValidUserIds = [...new Set([req.user._id.toString(), ...(Array.isArray(assignees) ? assignees : []), ...(assignedTo ? [assignedTo] : [])])];
    }

    // Validate assignees array — silently drop any IDs not in the project
    let validatedAssignees: string[] = [];
    if (assignees && Array.isArray(assignees) && assignees.length > 0) {
      validatedAssignees = assignees.filter((userId: string) => allValidUserIds.includes(userId));
      if (validatedAssignees.length !== assignees.length) {
        const invalidIds = assignees.filter((userId: string) => !allValidUserIds.includes(userId));
        logger.warn(`[createTask] Dropping invalid assignee IDs: ${JSON.stringify(invalidIds)}`);
      }
    }

    // For backward compatibility: if assignedTo is provided but not assignees, use assignedTo
    if (assignedTo && !assignees) {
      if (allValidUserIds.includes(assignedTo)) {
        validatedAssignees = [assignedTo];
      } else {
        logger.warn(`[createTask] Dropping invalid assignedTo ID: ${assignedTo}`);
      }
    }

    const subtaskAssigneeWhitelist = [...new Set([...allValidUserIds, ownerId])];
    const validatedSubtasks = normalizeEmbeddedSubtasks(subtasks, subtaskAssigneeWhitelist);

    // Get the highest order number for the list column
    const highestOrderTask = await Task.findOne(
      projectId
        ? { projectId, listId: validatedListId }
        : { createdBy: req.user._id, projectId: { $exists: false }, listId: validatedListId }
    ).sort({ order: -1 });

    const order = highestOrderTask ? highestOrderTask.order + 1 : 0;

    const task = new Task({
      title: title.trim(),
      description: description?.trim(),
      projectId: projectId || undefined,
      assignedTo: validatedAssignees.length === 1 ? validatedAssignees[0] : undefined, // backward compatibility
      assignees: validatedAssignees,
      assignedBy: req.user._id,
      assignedAt: validatedAssignees.length > 0 ? new Date() : undefined, // Track assignment time
      listId: validatedListId, // Use validated listId
      status: status || validatedListId || 'todo', // For backward compatibility
      priority: priority || 'medium',
      dueDate: new Date(dueDate),
      isSubtask: Boolean(isSubtask),
      parentTaskId: parentTaskId || undefined,
      reminderFrequency: reminderFrequency || 'none',
      customReminderMinutes: reminderFrequency === 'custom' ? Number(customReminderMinutes) : undefined,
      reminderStartTime: reminderStartTime || undefined,
      reminderEndTime: undefined, // not used — UI only sets start time
      subtasks: validatedSubtasks,
      createdBy: req.user._id,
      order
    });

    await task.save();
    if (validatedSubtasks.length > 0) {
      console.log('[tasks] Subtasks created and saved successfully', {
        taskId: task._id.toString(),
        count: validatedSubtasks.length,
        subtasks: validatedSubtasks.map((s) => ({ id: s.id, title: s.title, assigneeId: s.assigneeId }))
      });
    }
    await task.populate('assignedTo', 'displayName email avatar photoURL');
    await task.populate('assignees', 'displayName email avatar photoURL');
    await task.populate('assignedBy', 'displayName email avatar photoURL');
    await task.populate('projectId', 'name');

    logger.info(`Task created: ${task.title} in project ${projectId}`);

    // Log audit action
    if (projectId) {
      try {
      await AuditLog.logAction({
        projectId: projectId,
        userId: req.user._id,
        action: 'task_created',
        entityType: 'task',
        entityId: task._id.toString(),
        metadata: {
          taskTitle: task.title,
          taskId: task._id.toString(),
          status: task.status,
          listId: task.listId,
          priority: task.priority,
          // Extract IDs from populated assignees (task.assignees is populated)
          initialAssignees: task.assignees ? task.assignees.map((a: any) => a._id ? a._id.toString() : a.toString()) : [],
        },
      });
      } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
      }
    }

    // Broadcast to project room via socket
    const io = getIO();
    if (projectId) {
      broadcastToProject(io, projectId, 'task:created', {
        task,
        createdBy: {
          id: req.user._id,
          name: req.user.displayName,
          email: req.user.email
        },
        timestamp: new Date()
      });
    }

    // Send email notifications and create in-app notifications for assignees
    if (validatedAssignees.length > 0) {
      const assigneeEmails: string[] = [];
      const projectName = typeof task.projectId === 'object' && (task.projectId as any).name
        ? (task.projectId as any).name
        : 'No Project';

      // Get populated assignees
      if (task.assignees && Array.isArray(task.assignees)) {
        task.assignees.forEach((assignee: any) => {
          if (typeof assignee === 'object' && assignee.email && assignee._id.toString() !== req.user._id) {
            assigneeEmails.push(assignee.email);

            // Create in-app notification for each assignee
            createNotification({
              userId: assignee._id.toString(),
              type: 'task_assigned',
              title: 'New Task Assigned',
              message: `${req.user.displayName} assigned you a task "${task.title}" in ${projectName}`,
              metadata: {
                projectId: (projectId || '').toString(),
                projectName: projectName,
                taskId: task._id.toString(),
                taskTitle: task.title,
                actionBy: req.user._id,
                actionByName: req.user.displayName,
              },
            }).catch(error => {
              logger.error('Failed to create notification:', error);
            });
          }
        });
      }

      if (assigneeEmails.length > 0) {
        emailService.sendTaskAssignedNotification(assigneeEmails, {
          taskTitle: task.title,
          taskId: task._id.toString(),
          projectName,
          projectId: projectId || '',
          assignedByName: req.user.displayName,
          dueDate: task.dueDate,
          priority: task.priority
        }).catch(error => {
          logger.error('Failed to send task assignment emails:', error);
        });
      }
    }

    res.status(201);
    return successResponse(res, 'Task created successfully', task);

  } catch (error) {
    logger.error('Error creating task:', error);
    return internalServerErrorResponse(res, 'Failed to create task');
  }
};

export const updateTask = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Find the task first to check permissions
    const existingTask = await Task.findById(id);
    if (!existingTask) {
      return notFoundResponse(res, 'Task not found');
    }

    // Standalone task (no project): skip project-based checks entirely
    if (!existingTask.projectId) {
      const isStatusUpdateRequest =
        (typeof updates.status === 'string' && updates.status.trim().length > 0) ||
        (typeof updates.listId === 'string' && updates.listId.trim().length > 0);

      if (isStatusUpdateRequest) {
        const userId = req.user._id.toString();
        const isCreator = existingTask.createdBy?.toString() === userId;
        const isAssignedBy = existingTask.assignedBy?.toString() === userId;
        const existingAssignees = Array.isArray(existingTask.assignees) && existingTask.assignees.length > 0
          ? existingTask.assignees.map((assignee: any) => assignee.toString())
          : (existingTask.assignedTo ? [existingTask.assignedTo.toString()] : []);
        const isAssignedUser = existingAssignees.includes(userId);
        if (!isCreator && !isAssignedBy && !isAssignedUser) {
          return errorResponse(res, 'Only the task creator or assigned user can update this task', 403);
        }
      }

      // Normalize status/listId for standalone tasks too
      if (updates.listId) {
        const n = (updates.listId as string).toLowerCase().trim().replace('_', '-').replace('done', 'completed');
        updates.listId = n; updates.status = n;
      } else if (updates.status) {
        const n = (updates.status as string).toLowerCase().trim().replace('_', '-').replace('done', 'completed');
        updates.status = n; updates.listId = n;
      }

      const task = await Task.findByIdAndUpdate(id, { ...updates }, { new: true, runValidators: true })
        .populate('assignedTo', 'displayName email avatar photoURL')
        .populate('assignees', 'displayName email avatar photoURL')
        .populate('assignedBy', 'displayName email avatar photoURL')
        .populate('projectId', 'name color');

      if (!task) {
        return notFoundResponse(res, 'Task not found');
      }

      logger.info(`Standalone task updated: ${task.title}`);
      return successResponse(res, 'Task updated successfully', task);
    }

    // Check if user has access to the project
    const project = await Project.findById(existingTask.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is a member, manager, or owner of the project
    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
      ? project.ownerId._id.toString()
      : project.ownerId.toString();

    const isMember = project.members.some(member => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManagerCheck = project.managers && project.managers.some((manager) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManagerCheck;

    if (!isOwnerOrMemberOrManager) {
      return errorResponse(res, 'Access denied to this project', 403);
    }

    const isStatusUpdateRequest =
      (typeof updates.status === 'string' && updates.status.trim().length > 0) ||
      (typeof updates.listId === 'string' && updates.listId.trim().length > 0);

    if (isStatusUpdateRequest) {
      const existingAssignees = Array.isArray(existingTask.assignees) && existingTask.assignees.length > 0
        ? existingTask.assignees.map((assignee: any) => assignee.toString())
        : (existingTask.assignedTo ? [existingTask.assignedTo.toString()] : []);

      const isAssignedUser = existingAssignees.includes(req.user._id.toString());
      if (!isAssignedUser) {
        return errorResponse(res, 'Only the assigned user can update task status', 403);
      }
    }

    // Permission check is now handled by checkCanEditTask middleware
    // No need for additional permission checks here

    // Get all valid project member, manager, and owner IDs
    const projectMemberIds = project.members.map(m => m.toString());
    const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
    const allValidUserIds = [...new Set([...projectMemberIds, ...projectManagerIds, ownerId])];

    // Track old assignees for notification comparison
    const oldAssignees = existingTask.assignees ? existingTask.assignees.map((a: any) => a.toString()) : [];
    let newlyAssignedUsers: string[] = [];

    // Validate assignees array — silently drop any IDs no longer in the project
    if (updates.assignees && Array.isArray(updates.assignees) && updates.assignees.length > 0) {
      const validatedAssignees = updates.assignees.filter((userId: string) => allValidUserIds.includes(userId));
      if (validatedAssignees.length !== updates.assignees.length) {
        const invalidIds = updates.assignees.filter((userId: string) => !allValidUserIds.includes(userId));
        logger.warn(`[updateTask] Dropping invalid assignee IDs: ${JSON.stringify(invalidIds)} (not in project members/managers/owner). Valid: ${JSON.stringify(allValidUserIds)}`);
      }
      updates.assignees = validatedAssignees;
      // For backward compatibility, set assignedTo if there's only one assignee
      updates.assignedTo = validatedAssignees.length === 1 ? validatedAssignees[0] : undefined;

      // Set assignedAt timestamp if task wasn't previously assigned
      if (!existingTask.assignedAt && validatedAssignees.length > 0) {
        updates.assignedAt = new Date();
      }

      // Find newly assigned users (who weren't previously assigned)
      newlyAssignedUsers = validatedAssignees.filter((userId: string) => !oldAssignees.includes(userId));
    }

    // For backward compatibility: if assignedTo is provided but not assignees
    if (updates.assignedTo && !updates.assignees) {
      if (!allValidUserIds.includes(updates.assignedTo)) {
        logger.warn(`[updateTask] Dropping invalid assignedTo ID: ${updates.assignedTo}`);
        updates.assignedTo = undefined;
      } else {
        updates.assignees = [updates.assignedTo];

        // Set assignedAt timestamp if task wasn't previously assigned
        if (!existingTask.assignedAt) {
          updates.assignedAt = new Date();
        }

        // Check if this is a newly assigned user
        if (!oldAssignees.includes(updates.assignedTo)) {
          newlyAssignedUsers = [updates.assignedTo];
        }
      }
    }

    const subtaskAssigneeWhitelist = [...new Set([...allValidUserIds, ownerId])];
    if (Array.isArray(updates.subtasks)) {
      updates.subtasks = normalizeEmbeddedSubtasks(updates.subtasks, subtaskAssigneeWhitelist);
    }

    // Normalize status values (convert old format to new format)
    const normalizeStatus = (status: string): string => {
      const normalized = status.toLowerCase().trim();
      if (normalized === 'in_progress') return 'in-progress';
      if (normalized === 'done') return 'completed';
      return normalized;
    };

    // Synchronize listId and status for backward compatibility
    if (updates.listId) {
      const normalizedListId = normalizeStatus(updates.listId);
      updates.listId = normalizedListId;
      updates.status = normalizedListId;
    }
    // If status is being updated, also update listId so Kanban board reflects the change
    if (updates.status && !updates.listId) {
      const normalizedStatus = normalizeStatus(updates.status);
      updates.status = normalizedStatus;
      updates.listId = normalizedStatus;
    }

    // Set completedAt timestamp when task is marked as completed or done
    const completedStatuses = ['completed', 'done'];
    const currentStatus = updates.status || updates.listId || existingTask.status;
    const isNowCompleted = currentStatus && completedStatuses.includes(currentStatus.toLowerCase());
    const wasCompleted = completedStatuses.includes(existingTask.status?.toLowerCase() || '');

    if (isNowCompleted && !wasCompleted) {
      updates.completedAt = new Date();
      // Stop reminders when task is completed
      updates.reminderFrequency = 'none';
      updates.lastReminderSent = null;
      logger.info(`Task "${existingTask.title}" marked as completed by ${req.user.displayName}`);
    }

    // Clear completedAt if task is moved back from completed/done status
    if (currentStatus && !isNowCompleted && wasCompleted) {
      updates.completedAt = undefined;
      logger.info(`Task "${existingTask.title}" moved back from completed status`);
    }

    // Validate reminderFrequency if provided
    if (updates.reminderFrequency !== undefined) {
      const validFrequencies = ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'];
      if (!validFrequencies.includes(updates.reminderFrequency)) {
        return errorResponse(res, 'Invalid reminder frequency', 400);
      }
      if (updates.reminderFrequency === 'custom') {
        const customMinutes = Number(updates.customReminderMinutes);
        if (!Number.isFinite(customMinutes) || customMinutes < 1) {
          return errorResponse(res, 'Custom reminder minutes must be at least 1', 400);
        }
        updates.customReminderMinutes = customMinutes;
      } else {
        updates.customReminderMinutes = undefined;
      }
      // Reset lastReminderSent so the new frequency takes effect immediately
      updates.lastReminderSent = null;
    }

    // Save reminderStartTime — clear reminderEndTime (no longer used)
    if ('reminderStartTime' in updates) {
      updates.reminderStartTime = updates.reminderStartTime || null;
      // Reset so reminder fires at start time without waiting for old frequency gap
      updates.lastReminderSent = null;
    }
    // Always clear reminderEndTime — UI no longer sets it
    updates.reminderEndTime = null;

    // Apply updates
    const task = await Task.findByIdAndUpdate(
      id,
      { ...updates },
      { new: true, runValidators: true }
    ).populate('assignedTo', 'displayName email avatar photoURL')
     .populate('assignees', 'displayName email avatar photoURL')
     .populate('assignedBy', 'displayName email avatar photoURL')
     .populate('projectId', 'name color');

    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    if (Array.isArray(req.body.subtasks)) {
      const st = task.subtasks || [];
      console.log('[tasks] Subtasks saved successfully', {
        taskId: task._id.toString(),
        count: st.length,
        subtasks: st.map((s: any) => ({ id: s.id, title: s.title, assigneeId: s.assigneeId }))
      });
    }

    // Log audit action
    try {
      // Determine the primary action for this update
      const listChanged = updates.listId && updates.listId !== existingTask.listId;
      const statusChanged = (updates.status || updates.listId) && task.status !== existingTask.status;

      let action: IAuditLog['action'];
      if (isNowCompleted && !wasCompleted) {
        action = 'task_completed';
      } else if (listChanged || statusChanged) {
        action = 'task_status_changed';
      } else {
        action = 'task_updated';
      }

      const metadata: any = {
        taskTitle: task.title,
        taskId: task._id.toString(),
      };

      // Track list/status changes
      if (listChanged || statusChanged) {
        metadata.oldStatus = existingTask.status;
        metadata.newStatus = task.status;
        metadata.oldListId = existingTask.listId;
        metadata.newListId = task.listId;

        // Get list titles for better readability
        try {
          const projectWithColumns = await Project.findById(existingTask.projectId);
          if (projectWithColumns && projectWithColumns.columns) {
            const oldColumn = projectWithColumns.columns.find((col: any) => col.id === existingTask.listId);
            const newColumn = projectWithColumns.columns.find((col: any) => col.id === task.listId);
            if (oldColumn) metadata.oldListTitle = oldColumn.title;
            if (newColumn) metadata.newListTitle = newColumn.title;
          }
        } catch (columnError) {
          logger.error('Failed to get column titles for audit log:', columnError);
        }
      }

      // Track assignee changes
      // Extract IDs from populated assignees (task.assignees is populated, so we need to get ._id)
      const currentAssignees = task.assignees ? task.assignees.map((a: any) => {
        // Handle both populated documents and plain ObjectIds
        return a._id ? a._id.toString() : a.toString();
      }) : [];
      const assigneesChanged = JSON.stringify(oldAssignees.sort()) !== JSON.stringify(currentAssignees.sort());
      if (assigneesChanged) {
        metadata.assigneesChanged = true;
        metadata.oldAssignees = oldAssignees;
        metadata.newAssignees = currentAssignees;
        // Resolve assignee names for display
        try {
          const { User: UserModel } = require('../models');
          const allIds = [...new Set([...oldAssignees, ...currentAssignees])];
          const users = await UserModel.find({ _id: { $in: allIds } }).select('displayName email').lean();
          const idToName: Record<string, string> = {};
          users.forEach((u: any) => { idToName[u._id.toString()] = u.displayName || u.email; });
          metadata.oldAssigneeNames = oldAssignees.map((id: string) => idToName[id] || id);
          metadata.newAssigneeNames = currentAssignees.map((id: string) => idToName[id] || id);
        } catch { /* non-critical */ }
      }

      // Track field-level changes (title, description, priority, dueDate)
      const fieldChanges: Record<string, { from: any; to: any }> = {};
      if (updates.title !== undefined && updates.title !== existingTask.title) {
        fieldChanges.title = { from: existingTask.title, to: updates.title };
      }
      if (updates.description !== undefined && updates.description !== existingTask.description) {
        fieldChanges.description = {
          from: existingTask.description || '(none)',
          to: updates.description || '(none)'
        };
      }
      if (updates.priority !== undefined && updates.priority !== existingTask.priority) {
        fieldChanges.priority = { from: existingTask.priority, to: updates.priority };
      }
      const existingDue = existingTask.dueDate ? new Date(existingTask.dueDate).toISOString() : null;
      const newDue = updates.dueDate ? new Date(updates.dueDate).toISOString() : null;
      if (newDue !== null && newDue !== existingDue) {
        fieldChanges.dueDate = {
          from: existingDue,
          to: newDue
        };
      }
      if (Object.keys(fieldChanges).length > 0) {
        metadata.fieldChanges = fieldChanges;
      }

      await AuditLog.logAction({
        projectId: existingTask.projectId.toString(),
        userId: req.user._id,
        action,
        entityType: 'task',
        entityId: task._id.toString(),
        metadata,
      });
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    // Broadcast task update to project room via socket
    const io = getIO();
    broadcastToProject(io, existingTask.projectId.toString(), 'task:updated', {
      task,
      updatedBy: {
        id: req.user._id,
        name: req.user.displayName,
        email: req.user.email
      },
      timestamp: new Date()
    });

    // If task status changed to completed/done, broadcast performance update event
    if (isNowCompleted && !wasCompleted) {
      broadcastToProject(io, existingTask.projectId.toString(), 'performance:update', {
        projectId: existingTask.projectId.toString(),
        taskId: task._id,
        taskTitle: task.title,
        completedBy: req.user._id,
        completedByName: req.user.displayName,
        assignees: task.assignees,
        timestamp: new Date(),
        message: 'Task completed - performance metrics updated'
      });
      logger.info(`Performance update triggered: Task ${task.title} completed by ${req.user.displayName}`);
    }

    // Send notification to list members if task moved to a different list
    const listChanged = updates.listId && updates.listId !== existingTask.listId;
    logger.info(`Task update - listChanged: ${listChanged}, updates.listId: ${updates.listId}, existingTask.listId: ${existingTask.listId}`);

    if (listChanged) {
      try {
        // Get the project to find list members
        const User = (await import('../models/User')).default;
        const projectWithColumns = await Project.findById(existingTask.projectId);
        logger.info(`Project columns: ${JSON.stringify(projectWithColumns?.columns || [])}`);

        if (projectWithColumns) {
          // Find the target list/column
          const targetColumn = projectWithColumns.columns.find((col: any) => col.id === updates.listId);
          logger.info(`Target column found: ${targetColumn ? targetColumn.title : 'NOT FOUND'}`);
          logger.info(`Target column assignedMembers: ${JSON.stringify(targetColumn?.assignedMembers || [])}`);

          if (targetColumn) {
            const memberEmails: string[] = [];

            // Check if column has assigned members
            if (targetColumn.assignedMembers && targetColumn.assignedMembers.length > 0) {
              // Manually populate the assignedMembers to get their emails
              const assignedMemberIds = targetColumn.assignedMembers.map((id: any) => id.toString());
              const assignedMembersData = await User.find({
                _id: { $in: assignedMemberIds }
              }).select('email displayName');

              logger.info(`Found ${assignedMembersData.length} assigned members for the target column`);

              // Get emails of assigned members
              assignedMembersData.forEach((member: any) => {
                if (member.email && member.email !== req.user.email) {
                  memberEmails.push(member.email);
                }
              });
            }

            // Also check if the list title itself is an email address or username
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const isEmail = emailRegex.test(targetColumn.title);

            if (isEmail) {
              logger.info(`List title "${targetColumn.title}" appears to be an email address`);

              // Check if this email belongs to a project member
              const userByEmail = await User.findOne({ email: targetColumn.title }).select('email displayName _id');

              if (userByEmail) {
                // Check if user is a project member, manager, or owner
                const isProjectMember = projectWithColumns.members.some((m: any) => m.toString() === userByEmail._id.toString()) ||
                                       projectWithColumns.managers?.some((m: any) => m.toString() === userByEmail._id.toString()) ||
                                       projectWithColumns.ownerId.toString() === userByEmail._id.toString();

                if (isProjectMember && userByEmail.email !== req.user.email && !memberEmails.includes(userByEmail.email)) {
                  memberEmails.push(userByEmail.email);
                  logger.info(`Added list title email "${userByEmail.email}" to notification recipients`);
                }
              }
            } else {
              // Check if the list title is a username (displayName)
              logger.info(`List title "${targetColumn.title}" is not an email, checking if it's a username`);

              const userByDisplayName = await User.findOne({ displayName: targetColumn.title }).select('email displayName _id');

              if (userByDisplayName) {
                logger.info(`Found user with displayName "${targetColumn.title}": ${userByDisplayName.email}`);

                // Check if user is a project member, manager, or owner
                const isProjectMember = projectWithColumns.members.some((m: any) => m.toString() === userByDisplayName._id.toString()) ||
                                       projectWithColumns.managers?.some((m: any) => m.toString() === userByDisplayName._id.toString()) ||
                                       projectWithColumns.ownerId.toString() === userByDisplayName._id.toString();

                if (isProjectMember && userByDisplayName.email !== req.user.email && !memberEmails.includes(userByDisplayName.email)) {
                  memberEmails.push(userByDisplayName.email);
                  logger.info(`Added username "${targetColumn.title}" (email: ${userByDisplayName.email}) to notification recipients`);
                }
              } else {
                logger.info(`No user found with displayName "${targetColumn.title}"`);
              }
            }

            logger.info(`Member emails to notify: ${JSON.stringify(memberEmails)}`);

            if (memberEmails.length > 0) {
              // Fetch users to check notification preferences
              const User = (await import('../models/User')).default;
              const allUsers = await User.find({ email: { $in: memberEmails } }).select('_id email displayName settings');
              const oldList = projectWithColumns.columns?.find((col: any) => col.id === existingTask.listId);

              // Filter users who have email notifications enabled for task moved
              const usersWithEmailEnabled = allUsers.filter(user => {
                const emailEnabled = user.settings?.notifications?.emailNotifications !== false;
                const taskMovedEmailEnabled = user.settings?.notifications?.taskMovedEmail !== false;
                return emailEnabled && taskMovedEmailEnabled;
              });

              const emailRecipients = usersWithEmailEnabled.map(u => u.email);

              if (emailRecipients.length > 0) {
                // Send notification email
                await emailService.sendTaskMovedToListNotification(emailRecipients, {
                  taskTitle: task.title,
                  taskId: task._id.toString(),
                  projectName: projectWithColumns.name,
                  projectId: projectWithColumns._id.toString(),
                  listTitle: targetColumn.title,
                  movedByName: req.user.displayName || req.user.email,
                  priority: task.priority
                });
                logger.info(`Sent list notification for task "${task.title}" moved to "${targetColumn.title}" to ${emailRecipients.length} members`);
              }

              // Send real-time socket notifications for task moved
              const usersToNotify = allUsers;

              usersToNotify.forEach(user => {
                broadcastToUser(io, user._id.toString(), 'notification:task:moved', {
                  task: {
                    _id: task._id,
                    title: task.title,
                    projectId: task.projectId,
                    listId: task.listId,
                    status: task.status
                  },
                  fromList: oldList?.title || existingTask.listId || existingTask.status,
                  toList: targetColumn.title,
                  movedBy: {
                    displayName: req.user.displayName,
                    name: req.user.displayName,
                    email: req.user.email
                  }
                });
              });
              logger.info(`Sent real-time task moved notifications to ${usersToNotify.length} users`);

              // Send push notifications for task moved
              // Filter users who have push notifications enabled for task moved
              const { pushNotificationService } = await import('../services/pushNotificationService');
              const usersWithPushEnabled = usersToNotify.filter(user => {
                const pushEnabled = user.settings?.notifications?.pushNotifications !== false;
                const taskMovedPushEnabled = user.settings?.notifications?.taskMovedPush !== false;
                return pushEnabled && taskMovedPushEnabled;
              });

              for (const user of usersWithPushEnabled) {
                try {
                  await pushNotificationService.sendTaskMovedNotification(
                    user._id.toString(),
                    task.title,
                    oldList?.title || existingTask.listId || existingTask.status,
                    targetColumn.title,
                    req.user.displayName || req.user.email,
                    task.projectId.toString(),
                    task._id.toString()
                  );
                } catch (pushError) {
                  logger.error(`Failed to send push notification to user ${user._id}:`, pushError);
                }
              }
              logger.info(`Sent push notifications for task moved to ${usersWithPushEnabled.length} users`);
            } else {
              logger.info(`No member emails to notify (all filtered out or empty)`);
            }
          } else {
            logger.info(`Target column not found`);
          }
        } else {
          logger.warn(`Project not found when trying to send list notification`);
        }
      } catch (emailError) {
        logger.error('Error sending list notification email:', emailError);
        // Don't fail the request if email fails
      }
    }

    // Send notification to newly assigned users
    if (newlyAssignedUsers.length > 0) {
      try {
        logger.info(`Sending assignment notifications to ${newlyAssignedUsers.length} newly assigned users`);

        // Fetch user details for the newly assigned users
        const User = (await import('../models/User')).default;
        const users = await User.find({ _id: { $in: newlyAssignedUsers } }).select('email displayName settings');

        logger.info(`Found ${users.length} users to notify: ${users.map(u => u.email).join(', ')}`);

        // Create in-app notifications for newly assigned users (excluding self)
        users
          .filter(user => user._id.toString() !== req.user._id)
          .forEach(user => {
            createNotification({
              userId: user._id.toString(),
              type: 'task_assigned',
              title: 'New Task Assigned',
              message: `${req.user.displayName} assigned you a task "${task.title}" in ${project.name}`,
              metadata: {
                projectId: project._id.toString(),
                projectName: project.name,
                taskId: task._id.toString(),
                taskTitle: task.title,
                actionBy: req.user._id,
                actionByName: req.user.displayName,
              },
            }).catch(error => {
              logger.error('Failed to create notification:', error);
            });
          });

        // Filter out the person who assigned themselves and collect email addresses
        // Also check if user has email notifications enabled for task assignments
        const recipientEmails = users
          .filter(user => user._id.toString() !== req.user._id)
          .filter(user => {
            const emailEnabled = user.settings?.notifications?.emailNotifications !== false;
            const taskAssignedEmailEnabled = user.settings?.notifications?.taskAssignedEmail !== false;
            return emailEnabled && taskAssignedEmailEnabled;
          })
          .map(user => user.email);

        if (recipientEmails.length > 0) {
          await emailService.sendTaskAssignedNotification(
            recipientEmails,
            {
              taskTitle: task.title,
              taskId: task._id.toString(),
              projectName: project.name,
              projectId: project._id.toString(),
              assignedByName: req.user.displayName || req.user.email,
              priority: task.priority,
              dueDate: task.dueDate
            }
          );
          logger.info(`Sent assignment notification for task "${task.title}" to ${recipientEmails.length} users: ${recipientEmails.join(', ')}`);
        } else {
          logger.info(`No users to notify (user assigned themselves or email notifications disabled)`);
        }

        // Send real-time socket notifications to newly assigned users (excluding self)
        const usersToNotify = users.filter(user => user._id.toString() !== req.user._id);
        usersToNotify.forEach(user => {
          broadcastToUser(io, user._id.toString(), 'notification:task:assigned', {
            task: {
              _id: task._id,
              title: task.title,
              projectId: task.projectId,
              assignedBy: {
                displayName: req.user.displayName,
                name: req.user.displayName,
                email: req.user.email
              }
            },
            assignedTo: user._id.toString()
          });
        });
        logger.info(`Sent real-time notifications to ${usersToNotify.length} users`);

        // Send push notifications to newly assigned users (excluding self)
        // Check if user has push notifications enabled for task assignments
        const { pushNotificationService } = await import('../services/pushNotificationService');
        const usersWithPushEnabled = usersToNotify.filter(user => {
          const pushEnabled = user.settings?.notifications?.pushNotifications !== false;
          const taskAssignedPushEnabled = user.settings?.notifications?.taskAssignedPush !== false;
          return pushEnabled && taskAssignedPushEnabled;
        });

        for (const user of usersWithPushEnabled) {
          try {
            await pushNotificationService.sendTaskAssignedNotification(
              user._id.toString(),
              task.title,
              req.user.displayName || req.user.email,
              task.projectId.toString(),
              task._id.toString()
            );
          } catch (pushError) {
            logger.error(`Failed to send push notification to user ${user._id}:`, pushError);
          }
        }
        logger.info(`Sent push notifications to ${usersWithPushEnabled.length} users`);
      } catch (emailError) {
        logger.error('Error sending assignment notification emails:', emailError);
        // Don't fail the request if email fails
      }
    }

    logger.info(`Task updated: ${task.title}`);
    return successResponse(res, 'Task updated successfully', task);
  } catch (error) {
    logger.error('Error updating task:', error);
    return internalServerErrorResponse(res, 'Failed to update task');
  }
};

export const deleteTask = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Find the task first to check permissions
    const task = await Task.findById(id);
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Permission check is handled by checkCanDeleteTask middleware
    // For standalone tasks (no project), skip project lookup entirely
    if (!task.projectId) {
      await Task.findByIdAndDelete(id);
      logger.info(`Standalone task deleted: ${task.title}`);
      return successResponse(res, 'Task deleted successfully');
    }

    // Check if user has access to the project
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const projectId = task.projectId.toString();
    const taskTitle = task.title;

    await Task.findByIdAndDelete(id);

    // Log audit event for task deletion
    await AuditLog.logAction({
      projectId: projectId,
      userId: req.user._id,
      action: 'task_deleted',
      entityType: 'task',
      entityId: id,
      metadata: {
        taskTitle: taskTitle,
        taskId: id,
        status: task.status,
        listId: task.listId,
      },
    });

    // Broadcast task deletion to project room via socket
    const io = getIO();
    broadcastToProject(io, projectId, 'task:deleted', {
      taskId: id,
      deletedBy: {
        id: req.user._id,
        name: req.user.displayName,
        email: req.user.email
      },
      timestamp: new Date()
    });

    logger.info(`Task deleted: ${taskTitle}`);
    return successResponse(res, 'Task deleted successfully');
  } catch (error) {
    logger.error('Error deleting task:', error);
    return internalServerErrorResponse(res, 'Failed to delete task');
  }
};

export const reorderTasks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    logger.info('=== REORDER TASKS REQUEST ===');
    logger.info(`Request body: ${JSON.stringify(req.body, null, 2)}`);
    logger.info(`User: ${req.user?.email || 'unknown'}`);

    const { projectId, tasks } = req.body;

    if (!projectId) {
      logger.error('Missing projectId in request');
      return errorResponse(res, 'Project ID is required', 400);
    }

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      logger.error(`Invalid tasks array - tasks: ${JSON.stringify(tasks)}, isArray: ${Array.isArray(tasks)}, length: ${tasks?.length}`);
      return errorResponse(res, 'Tasks array is required', 400);
    }

    // Check if project exists and user has access
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is a member, manager, or owner of the project
    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
      ? project.ownerId._id.toString()
      : project.ownerId.toString();

    const isMember = project.members.some(member => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager) => {
      const managerId = typeof manager === 'object' && manager._id
        ? manager._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager;

    if (!isOwnerOrMemberOrManager) {
      return errorResponse(res, 'Access denied to this project', 403);
    }

    // Use the model's reorderTasks method
    await Task.reorderTasks(
      projectId, 
      tasks.map((task: any) => ({
        _id: task.id,
        status: task.status,
        order: task.order
      }))
    );

    logger.info(`Tasks reordered in project: ${projectId}`);
    return successResponse(res, 'Tasks reordered successfully');
  } catch (error) {
    logger.error('Error reordering tasks:', error);
    return internalServerErrorResponse(res, 'Failed to reorder tasks');
  }
};

// Get task history (audit logs for a specific task)
export const getTaskHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Verify task exists and user has access
    const task = await Task.findById(id).populate('projectId');
    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    const project = task.projectId as any;
    if (!project) {
      // Standalone tasks currently don't have project-scoped audit logs; return empty history.
      return successResponse(res, 'Task history retrieved successfully', []);
    }

    // Check if user has access to the project
    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
      ? project.ownerId._id.toString()
      : project.ownerId.toString();

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

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager;

    if (!isOwnerOrMemberOrManager) {
      return errorResponse(res, 'Access denied to this task', 403);
    }

    // Fetch audit logs for this task
    const allHistory = await AuditLog.find({
      projectId: project._id,
      $or: [
        { entityId: id },
        { 'metadata.taskId': id }
      ]
    })
      .populate('userId', 'displayName email photoURL isActive')
      .sort({ createdAt: -1 })
      .limit(200); // Get more to filter out inactive users

    // Filter out logs for deleted or inactive users
    const { User } = require('../models');
    const history: any[] = [];
    
    for (const log of allHistory) {
      if (log.userId) {
        const userId = typeof log.userId === 'object' && (log.userId as any)._id 
          ? (log.userId as any)._id.toString() 
          : log.userId.toString();
        
        // Check if user exists and is active
        const user = await User.findById(userId).select('isActive').lean();
        if (user && user.isActive !== false) {
          history.push(log);
          if (history.length >= 100) {
            break;
          }
        }
      }
    }

    // Transform the history to a more readable format
    const formattedHistory = history.map((log: any) => ({
      action: log.action,
      user: {
        name: log.userId?.displayName || 'Unknown',
        email: log.userId?.email || ''
      },
      timestamp: log.createdAt,
      description: getActionDescription(log),
      changes: extractChanges(log.metadata),
      metadata: log.metadata
    }));

    return successResponse(res, 'Task history retrieved successfully', formattedHistory);
  } catch (error) {
    logger.error('Error fetching task history:', error);
    return internalServerErrorResponse(res, 'Failed to fetch task history');
  }
};

// Helper function to get human-readable action description
function getActionDescription(log: any): string {
  const metadata = log.metadata || {};
  const fc = metadata.fieldChanges || {};
  const changedFields = Object.keys(fc);

  switch (log.action) {
    case 'task_created':
      return `Created task "${metadata.taskTitle || 'Unknown'}"`;
    case 'task_updated': {
      if (changedFields.length > 0) {
        return `Updated ${changedFields.join(', ')}`;
      }
      if (metadata.assigneesChanged) return 'Updated assignees';
      return 'Updated task';
    }
    case 'task_assigned':
      return `Assigned task to ${metadata.assigneeName || 'someone'}`;
    case 'task_status_changed': {
      const from = metadata.oldListTitle || metadata.oldStatus || '?';
      const to = metadata.newListTitle || metadata.newStatus || '?';
      return `Moved from "${from}" to "${to}"`;
    }
    case 'task_completed':
      return 'Marked task as completed';
    case 'task_deleted':
      return 'Deleted this task';
    default:
      return log.action.replace(/_/g, ' ');
  }
}

// Helper function to extract field changes
function extractChanges(metadata: any): any {
  if (!metadata) return {};

  const changes: any = {};

  // Status change
  if (metadata.oldStatus && metadata.newStatus && metadata.oldStatus !== metadata.newStatus) {
    changes.status = { from: metadata.oldStatus, to: metadata.newStatus };
  }

  // List/column change
  if (metadata.oldListTitle && metadata.newListTitle && metadata.oldListTitle !== metadata.newListTitle) {
    changes.column = { from: metadata.oldListTitle, to: metadata.newListTitle };
  }

  // Field-level changes (title, description, priority, dueDate)
  if (metadata.fieldChanges && typeof metadata.fieldChanges === 'object') {
    Object.assign(changes, metadata.fieldChanges);
  }

  // Assignee changes — prefer display names over IDs
  if (metadata.assigneesChanged) {
    const oldNames: string[] = metadata.oldAssigneeNames || metadata.oldAssignees || [];
    const newNames: string[] = metadata.newAssigneeNames || metadata.newAssignees || [];
    const added = newNames.filter((n: string) => !oldNames.includes(n));
    const removed = oldNames.filter((n: string) => !newNames.includes(n));
    if (added.length > 0 || removed.length > 0) {
      changes.assignees = {
        from: oldNames.length > 0 ? oldNames.join(', ') : 'None',
        to: newNames.length > 0 ? newNames.join(', ') : 'None',
      };
    }
  }

  // Legacy single-assignee change
  if (!changes.assignees && (metadata.oldAssignee || metadata.newAssignee)) {
    changes.assignees = {
      from: metadata.oldAssignee || 'None',
      to: metadata.newAssignee || 'None',
    };
  }

  // Any extra changes stored directly
  if (metadata.changes && typeof metadata.changes === 'object') {
    Object.assign(changes, metadata.changes);
  }

  return changes;
}