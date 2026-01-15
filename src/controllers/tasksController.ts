import { Request, Response } from 'express';
import { Task, Project } from '../models';
import { AuditLog } from '../models/AuditLog';
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
          .populate('assignees', 'displayName email avatar photoURL')
          .populate('assignedTo', 'displayName email avatar photoURL')
          .populate('assignedBy', 'displayName email avatar photoURL')
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
    const { title, description, projectId, assignedTo, assignees, status, listId, priority, dueDate, reminderFrequency } = req.body;

    if (!title?.trim()) {
      return errorResponse(res, 'Task title is required', 400);
    }

    if (!projectId) {
      return errorResponse(res, 'Project ID is required', 400);
    }

    if (!dueDate) {
      return errorResponse(res, 'Due date is required', 400);
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
      dueDate: new Date(dueDate),
      reminderFrequency: reminderFrequency || '24hours', // Default to 24 hours if not specified
      createdBy: req.user._id,
      order
    });

    await task.save();
    await task.populate('assignedTo', 'displayName email avatar photoURL');
    await task.populate('assignees', 'displayName email avatar photoURL');
    await task.populate('assignedBy', 'displayName email avatar photoURL');
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
          // Extract IDs from populated assignees (task.assignees is populated)
          initialAssignees: task.assignees ? task.assignees.map((a: any) => a._id ? a._id.toString() : a.toString()) : [],
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

    // Send email notifications and create in-app notifications for assignees
    if (validatedAssignees.length > 0) {
      const assigneeEmails: string[] = [];
      const projectName = typeof task.projectId === 'object' && (task.projectId as any).name
        ? (task.projectId as any).name
        : 'Unknown Project';

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
                projectId: projectId.toString(),
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

    // Track old assignees for notification comparison
    const oldAssignees = existingTask.assignees ? existingTask.assignees.map((a: any) => a.toString()) : [];
    let newlyAssignedUsers: string[] = [];

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

      // Find newly assigned users (who weren't previously assigned)
      newlyAssignedUsers = validatedAssignees.filter((userId: string) => !oldAssignees.includes(userId));
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

      // Check if this is a newly assigned user
      if (!oldAssignees.includes(updates.assignedTo)) {
        newlyAssignedUsers = [updates.assignedTo];
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

    // Validate reminderFrequency if provided
    if (updates.reminderFrequency !== undefined) {
      const validFrequencies = ['none', '1hour', '3hours', '12hours', '24hours', '48hours'];
      if (!validFrequencies.includes(updates.reminderFrequency)) {
        return errorResponse(res, 'Invalid reminder frequency', 400);
      }
    }

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
      return notFoundResponse(res, 'Project not found');
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

  switch (log.action) {
    case 'task_created':
      return `Task "${metadata.taskTitle || 'Unknown'}" was created`;
    case 'task_updated':
      return 'Task was updated';
    case 'task_assigned':
      return `Task assigned to ${metadata.assigneeName || 'someone'}`;
    case 'task_status_changed':
      return `Status changed from "${metadata.oldStatus || 'Unknown'}" to "${metadata.newStatus || 'Unknown'}"`;
    case 'task_completed':
      return 'Task was marked as completed';
    case 'task_deleted':
      return 'Task was deleted';
    default:
      return log.action.replace(/_/g, ' ');
  }
}

// Helper function to extract field changes
function extractChanges(metadata: any): any {
  if (!metadata) return {};

  const changes: any = {};

  // Extract status change
  if (metadata.oldStatus && metadata.newStatus) {
    changes.status = {
      from: metadata.oldStatus,
      to: metadata.newStatus
    };
  }

  // Extract priority change
  if (metadata.oldPriority && metadata.newPriority) {
    changes.priority = {
      from: metadata.oldPriority,
      to: metadata.newPriority
    };
  }

  // Extract assignee change
  if (metadata.oldAssignee || metadata.newAssignee) {
    changes.assignee = {
      from: metadata.oldAssignee || 'None',
      to: metadata.newAssignee || 'None'
    };
  }

  // Extract other field changes from metadata
  if (metadata.changes) {
    Object.assign(changes, metadata.changes);
  }

  return changes;
}