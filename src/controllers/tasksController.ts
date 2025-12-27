import { Request, Response } from 'express';
import { Task, Project } from '../models';
import { AuditLog } from '../models/AuditLog';
import { ProjectPermission } from '../models/ProjectPermission';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { getIO } from '../socket';
import { broadcastToProject, broadcastToUser } from '../socket/socketHandlers';
import { emailService } from '../services/emailService';

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

    const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManager;

      if (!isOwnerOrMemberOrManager) {
        return errorResponse(res, 'Access denied to this project', 403);
      }

      // Check if user has canViewAllTasks permission
      const isOwner = ownerId === req.user._id;
      let canViewAllTasks = isOwner; // Owners can always view all tasks

      if (!isOwner) {
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
        }).populate('projectId', 'name')
          .populate('assignees', 'name email avatar')
          .populate('assignedTo', 'name email avatar')
          .populate('assignedBy', 'name email avatar')
          .sort({ createdAt: -1 }); // Newest first
      } else {
        // Can only view tasks assigned to them or created by them
        tasks = await Task.find({
          projectId,
          $or: [
            { assignedTo: req.user._id },
            { assignees: req.user._id },
            { assignedBy: req.user._id }
          ]
        }).populate('projectId', 'name')
          .populate('assignees', 'name email avatar')
          .populate('assignedTo', 'name email avatar')
          .populate('assignedBy', 'name email avatar')
          .sort({ createdAt: -1 }); // Newest first
      }
    } else {
      // No projectId ➜ fetch tasks based on user's role and permissions
      // Find all projects where user is owner, member, or manager
      const userProjects = await Project.find({
        $or: [
          { ownerId: req.user._id },
          { members: req.user._id },
          { managers: req.user._id }
        ]
      }).select('_id ownerId');

      const projectIds = userProjects.map(p => p._id);

      // For managers/owners: show ALL tasks in their projects
      const managedProjectIds = userProjects
        .filter(p => p.ownerId.toString() === req.user._id.toString())
        .map(p => p._id);

      // Also include projects where user is a manager
      const managerProjects = await Project.find({
        managers: req.user._id
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
        .populate('assignees', 'name email avatar')
        .populate('assignedTo', 'name email avatar')
        .populate('assignedBy', 'name email avatar')
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
      .populate('assignees', 'name email avatar')
      .populate('assignedTo', 'name email avatar')
      .populate('assignedBy', 'name email avatar');

    if (!task) {
      return notFoundResponse(res, 'Task not found');
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
    const { title, description, projectId, assignedTo, assignees, status, listId, priority, dueDate } = req.body;

    if (!title?.trim()) {
      return errorResponse(res, 'Task title is required', 400);
    }

    if (!projectId) {
      return errorResponse(res, 'Project ID is required', 400);
    }

    // Check if project exists and user has access
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Validate listId if provided - check if it exists in project's columns
    let validatedListId = listId || status || 'todo';
    if (project.columns && project.columns.length > 0) {
      const listExists = project.columns.some(col => col.id === validatedListId);
      if (!listExists) {
        // If provided listId doesn't exist, use the first column
        validatedListId = project.columns[0].id;
      }
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

    // Get all valid project member and manager IDs
    const projectMemberIds = project.members.map(m => m.toString());
    const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
    const allValidUserIds = [...projectMemberIds, ...projectManagerIds];

    // Validate assignees array - allow assigning to both members and managers
    let validatedAssignees: string[] = [];
    if (assignees && Array.isArray(assignees) && assignees.length > 0) {
      validatedAssignees = assignees.filter((userId: string) => allValidUserIds.includes(userId));
      if (validatedAssignees.length !== assignees.length) {
        return errorResponse(res, 'Some assigned users are not project members or managers', 400);
      }
    }

    // For backward compatibility: if assignedTo is provided but not assignees, use assignedTo
    if (assignedTo && !assignees) {
      if (!allValidUserIds.includes(assignedTo)) {
        return errorResponse(res, 'Assigned user is not a project member or manager', 400);
      }
      validatedAssignees = [assignedTo];
    }

    // Get the highest order number for the list column
    const highestOrderTask = await Task.findOne({
      projectId,
      listId: validatedListId
    }).sort({ order: -1 });

    const order = highestOrderTask ? highestOrderTask.order + 1 : 0;

    const task = new Task({
      title: title.trim(),
      description: description?.trim(),
      projectId,
      assignedTo: validatedAssignees.length === 1 ? validatedAssignees[0] : undefined, // backward compatibility
      assignees: validatedAssignees,
      assignedBy: req.user._id,
      assignedAt: validatedAssignees.length > 0 ? new Date() : undefined, // Track assignment time
      listId: validatedListId, // Use validated listId
      status: status || validatedListId || 'todo', // For backward compatibility
      priority: priority || 'medium',
      dueDate: dueDate ? new Date(dueDate) : undefined,
      createdBy: req.user._id,
      order
    });

    await task.save();
    await task.populate('assignedTo', 'name email avatar');
    await task.populate('assignees', 'name email avatar');
    await task.populate('assignedBy', 'name email avatar');
    await task.populate('projectId', 'name');

    logger.info(`Task created: ${task.title} in project ${projectId}`);

    // Log audit action
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
        },
      });
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
    }

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, projectId, 'task:created', {
      task,
      createdBy: {
        id: req.user._id,
        name: req.user.displayName,
        email: req.user.email
      },
      timestamp: new Date()
    });

    // Send email notifications to assignees
    if (validatedAssignees.length > 0) {
      const assigneeEmails: string[] = [];

      // Get populated assignees
      if (task.assignees && Array.isArray(task.assignees)) {
        task.assignees.forEach((assignee: any) => {
          if (typeof assignee === 'object' && assignee.email && assignee._id.toString() !== req.user._id) {
            assigneeEmails.push(assignee.email);
          }
        });
      }

      if (assigneeEmails.length > 0) {
        const projectName = typeof task.projectId === 'object' && (task.projectId as any).name
          ? (task.projectId as any).name
          : 'Unknown Project';

        emailService.sendTaskAssignedNotification(assigneeEmails, {
          taskTitle: task.title,
          taskId: task._id.toString(),
          projectName,
          projectId: projectId,
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

    // Permission check is now handled by checkCanEditTask middleware
    // No need for additional permission checks here

    // Get all valid project member and manager IDs
    const projectMemberIds = project.members.map(m => m.toString());
    const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
    const allValidUserIds = [...projectMemberIds, ...projectManagerIds];

    // Validate assignees array - allow assigning to both members and managers
    if (updates.assignees && Array.isArray(updates.assignees) && updates.assignees.length > 0) {
      const validatedAssignees = updates.assignees.filter((userId: string) => allValidUserIds.includes(userId));
      if (validatedAssignees.length !== updates.assignees.length) {
        return errorResponse(res, 'Some assigned users are not project members or managers', 400);
      }
      updates.assignees = validatedAssignees;
      // For backward compatibility, set assignedTo if there's only one assignee
      updates.assignedTo = validatedAssignees.length === 1 ? validatedAssignees[0] : undefined;

      // Set assignedAt timestamp if task wasn't previously assigned
      if (!existingTask.assignedAt && validatedAssignees.length > 0) {
        updates.assignedAt = new Date();
      }
    }

    // For backward compatibility: if assignedTo is provided but not assignees
    if (updates.assignedTo && !updates.assignees) {
      if (!allValidUserIds.includes(updates.assignedTo)) {
        return errorResponse(res, 'Assigned user is not a project member or manager', 400);
      }
      updates.assignees = [updates.assignedTo];

      // Set assignedAt timestamp if task wasn't previously assigned
      if (!existingTask.assignedAt) {
        updates.assignedAt = new Date();
      }
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
      logger.info(`Task "${existingTask.title}" marked as completed by ${req.user.displayName}`);
    }

    // Clear completedAt if task is moved back from completed/done status
    if (currentStatus && !isNowCompleted && wasCompleted) {
      updates.completedAt = undefined;
      logger.info(`Task "${existingTask.title}" moved back from completed status`);
    }

    // Apply updates
    const task = await Task.findByIdAndUpdate(
      id,
      { ...updates },
      { new: true, runValidators: true }
    ).populate('assignedTo', 'name email avatar')
     .populate('assignees', 'name email avatar')
     .populate('assignedBy', 'name email avatar')
     .populate('projectId', 'name color');

    if (!task) {
      return notFoundResponse(res, 'Task not found');
    }

    // Log audit action
    try {
      const action = isNowCompleted && !wasCompleted ? 'task_completed' : 'task_updated';
      const metadata: any = {
        taskTitle: task.title,
        taskId: task._id.toString(),
      };

      // Track status changes
      if (updates.status || updates.listId) {
        metadata.oldStatus = existingTask.status;
        metadata.newStatus = task.status;
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

    // Check if user has access to the project
    const project = await Project.findById(task.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Permission check is now handled by checkCanDeleteTask middleware
    // No need for additional permission checks here

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
    const { projectId, tasks } = req.body;

    if (!projectId) {
      return errorResponse(res, 'Project ID is required', 400);
    }

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
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