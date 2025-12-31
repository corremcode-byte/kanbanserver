"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reorderTasks = exports.deleteTask = exports.updateTask = exports.createTask = exports.getTask = exports.getTasks = void 0;
const models_1 = require("../models");
const AuditLog_1 = require("../models/AuditLog");
const ProjectPermission_1 = require("../models/ProjectPermission");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const socket_1 = require("../socket");
const socketHandlers_1 = require("../socket/socketHandlers");
const emailService_1 = require("../services/emailService");
const getTasks = async (req, res) => {
    try {
        const { projectId } = req.query;
        let tasks;
        if (projectId) {
            const project = await models_1.Project.findById(projectId);
            if (!project) {
                return (0, responses_1.notFoundResponse)(res, 'Project not found');
            }
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
                return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
            }
            const isOwner = ownerId === req.user._id;
            let canViewAllTasks = isOwner;
            if (!isOwner) {
                const userPermission = await ProjectPermission_1.ProjectPermission.findOne({
                    projectId,
                    userId: req.user._id
                });
                canViewAllTasks = userPermission?.permissions?.canViewAllTasks || false;
            }
            if (canViewAllTasks) {
                tasks = await models_1.Task.find({
                    projectId,
                }).populate('projectId', 'name')
                    .populate('assignees', 'name email avatar')
                    .populate('assignedTo', 'name email avatar')
                    .populate('assignedBy', 'name email avatar')
                    .sort({ createdAt: -1 });
            }
            else {
                tasks = await models_1.Task.find({
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
                    .sort({ createdAt: -1 });
            }
        }
        else {
            const userProjects = await models_1.Project.find({
                $or: [
                    { ownerId: req.user._id },
                    { members: req.user._id },
                    { managers: req.user._id }
                ]
            }).select('_id ownerId');
            const projectIds = userProjects.map(p => p._id);
            const managedProjectIds = userProjects
                .filter(p => p.ownerId.toString() === req.user._id.toString())
                .map(p => p._id);
            const managerProjects = await models_1.Project.find({
                managers: req.user._id
            }).select('_id');
            managedProjectIds.push(...managerProjects.map(p => p._id));
            const permissionsWithViewAll = await ProjectPermission_1.ProjectPermission.find({
                userId: req.user._id,
                projectId: { $in: projectIds },
                'permissions.canViewAllTasks': true
            }).select('projectId');
            const viewAllTasksProjectIds = permissionsWithViewAll.map(p => p.projectId);
            const allAccessProjectIds = [
                ...managedProjectIds,
                ...viewAllTasksProjectIds
            ];
            tasks = await models_1.Task.find({
                $or: [
                    { assignedTo: req.user._id },
                    { assignees: req.user._id },
                    { assignedBy: req.user._id },
                    { projectId: { $in: allAccessProjectIds } }
                ]
            }).populate('projectId', 'name')
                .populate('assignees', 'name email avatar')
                .populate('assignedTo', 'name email avatar')
                .populate('assignedBy', 'name email avatar')
                .sort({ createdAt: -1 });
        }
        return (0, responses_1.successResponse)(res, 'Tasks retrieved successfully', tasks);
    }
    catch (error) {
        logger_1.logger.error('Error getting tasks:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to fetch tasks');
    }
};
exports.getTasks = getTasks;
const getTask = async (req, res) => {
    try {
        const { id } = req.params;
        const task = await models_1.Task.findById(id)
            .populate('projectId', 'name')
            .populate('assignees', 'name email avatar')
            .populate('assignedTo', 'name email avatar')
            .populate('assignedBy', 'name email avatar');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await models_1.Project.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
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
            return (0, responses_1.errorResponse)(res, 'Access denied to this task', 403);
        }
        return (0, responses_1.successResponse)(res, 'Task retrieved successfully', task);
    }
    catch (error) {
        logger_1.logger.error('Error getting task:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to fetch task');
    }
};
exports.getTask = getTask;
const createTask = async (req, res) => {
    try {
        const { title, description, projectId, assignedTo, assignees, status, listId, priority, dueDate, reminderFrequency } = req.body;
        if (!title?.trim()) {
            return (0, responses_1.errorResponse)(res, 'Task title is required', 400);
        }
        if (!projectId) {
            return (0, responses_1.errorResponse)(res, 'Project ID is required', 400);
        }
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        let validatedListId = listId || status || 'todo';
        if (project.columns && project.columns.length > 0) {
            const listExists = project.columns.some(col => col.id === validatedListId);
            if (!listExists) {
                validatedListId = project.columns[0].id;
            }
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
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        const projectMemberIds = project.members.map(m => m.toString());
        const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
        const allValidUserIds = [...projectMemberIds, ...projectManagerIds];
        let validatedAssignees = [];
        if (assignees && Array.isArray(assignees) && assignees.length > 0) {
            validatedAssignees = assignees.filter((userId) => allValidUserIds.includes(userId));
            if (validatedAssignees.length !== assignees.length) {
                return (0, responses_1.errorResponse)(res, 'Some assigned users are not project members or managers', 400);
            }
        }
        if (assignedTo && !assignees) {
            if (!allValidUserIds.includes(assignedTo)) {
                return (0, responses_1.errorResponse)(res, 'Assigned user is not a project member or manager', 400);
            }
            validatedAssignees = [assignedTo];
        }
        const highestOrderTask = await models_1.Task.findOne({
            projectId,
            listId: validatedListId
        }).sort({ order: -1 });
        const order = highestOrderTask ? highestOrderTask.order + 1 : 0;
        const task = new models_1.Task({
            title: title.trim(),
            description: description?.trim(),
            projectId,
            assignedTo: validatedAssignees.length === 1 ? validatedAssignees[0] : undefined,
            assignees: validatedAssignees,
            assignedBy: req.user._id,
            assignedAt: validatedAssignees.length > 0 ? new Date() : undefined,
            listId: validatedListId,
            status: status || validatedListId || 'todo',
            priority: priority || 'medium',
            dueDate: dueDate ? new Date(dueDate) : undefined,
            reminderFrequency: reminderFrequency || '24hours',
            createdBy: req.user._id,
            order
        });
        await task.save();
        await task.populate('assignedTo', 'name email avatar');
        await task.populate('assignees', 'name email avatar');
        await task.populate('assignedBy', 'name email avatar');
        await task.populate('projectId', 'name');
        logger_1.logger.info(`Task created: ${task.title} in project ${projectId}`);
        try {
            await AuditLog_1.AuditLog.logAction({
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
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, projectId, 'task:created', {
            task,
            createdBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        if (validatedAssignees.length > 0) {
            const assigneeEmails = [];
            if (task.assignees && Array.isArray(task.assignees)) {
                task.assignees.forEach((assignee) => {
                    if (typeof assignee === 'object' && assignee.email && assignee._id.toString() !== req.user._id) {
                        assigneeEmails.push(assignee.email);
                    }
                });
            }
            if (assigneeEmails.length > 0) {
                const projectName = typeof task.projectId === 'object' && task.projectId.name
                    ? task.projectId.name
                    : 'Unknown Project';
                emailService_1.emailService.sendTaskAssignedNotification(assigneeEmails, {
                    taskTitle: task.title,
                    taskId: task._id.toString(),
                    projectName,
                    projectId: projectId,
                    assignedByName: req.user.displayName,
                    dueDate: task.dueDate,
                    priority: task.priority
                }).catch(error => {
                    logger_1.logger.error('Failed to send task assignment emails:', error);
                });
            }
        }
        res.status(201);
        return (0, responses_1.successResponse)(res, 'Task created successfully', task);
    }
    catch (error) {
        logger_1.logger.error('Error creating task:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to create task');
    }
};
exports.createTask = createTask;
const updateTask = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const existingTask = await models_1.Task.findById(id);
        if (!existingTask) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await models_1.Project.findById(existingTask.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
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
        const isManagerCheck = project.managers && project.managers.some((manager) => {
            const managerId = typeof manager === 'object' && manager._id
                ? manager._id.toString()
                : manager.toString();
            return managerId === req.user._id;
        });
        const isOwnerOrMemberOrManager = ownerId === req.user._id || isMember || isManagerCheck;
        if (!isOwnerOrMemberOrManager) {
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        const projectMemberIds = project.members.map(m => m.toString());
        const projectManagerIds = project.managers ? project.managers.map(m => m.toString()) : [];
        const allValidUserIds = [...projectMemberIds, ...projectManagerIds];
        if (updates.assignees && Array.isArray(updates.assignees) && updates.assignees.length > 0) {
            const validatedAssignees = updates.assignees.filter((userId) => allValidUserIds.includes(userId));
            if (validatedAssignees.length !== updates.assignees.length) {
                return (0, responses_1.errorResponse)(res, 'Some assigned users are not project members or managers', 400);
            }
            updates.assignees = validatedAssignees;
            updates.assignedTo = validatedAssignees.length === 1 ? validatedAssignees[0] : undefined;
            if (!existingTask.assignedAt && validatedAssignees.length > 0) {
                updates.assignedAt = new Date();
            }
        }
        if (updates.assignedTo && !updates.assignees) {
            if (!allValidUserIds.includes(updates.assignedTo)) {
                return (0, responses_1.errorResponse)(res, 'Assigned user is not a project member or manager', 400);
            }
            updates.assignees = [updates.assignedTo];
            if (!existingTask.assignedAt) {
                updates.assignedAt = new Date();
            }
        }
        const normalizeStatus = (status) => {
            const normalized = status.toLowerCase().trim();
            if (normalized === 'in_progress')
                return 'in-progress';
            if (normalized === 'done')
                return 'completed';
            return normalized;
        };
        if (updates.listId) {
            const normalizedListId = normalizeStatus(updates.listId);
            updates.listId = normalizedListId;
            updates.status = normalizedListId;
        }
        if (updates.status && !updates.listId) {
            const normalizedStatus = normalizeStatus(updates.status);
            updates.status = normalizedStatus;
            updates.listId = normalizedStatus;
        }
        const completedStatuses = ['completed', 'done'];
        const currentStatus = updates.status || updates.listId || existingTask.status;
        const isNowCompleted = currentStatus && completedStatuses.includes(currentStatus.toLowerCase());
        const wasCompleted = completedStatuses.includes(existingTask.status?.toLowerCase() || '');
        if (isNowCompleted && !wasCompleted) {
            updates.completedAt = new Date();
            logger_1.logger.info(`Task "${existingTask.title}" marked as completed by ${req.user.displayName}`);
        }
        if (currentStatus && !isNowCompleted && wasCompleted) {
            updates.completedAt = undefined;
            logger_1.logger.info(`Task "${existingTask.title}" moved back from completed status`);
        }
        if (updates.reminderFrequency !== undefined) {
            const validFrequencies = ['none', '1min', '1hour', '3hours', '12hours', '24hours'];
            if (!validFrequencies.includes(updates.reminderFrequency)) {
                return (0, responses_1.errorResponse)(res, 'Invalid reminder frequency', 400);
            }
        }
        const task = await models_1.Task.findByIdAndUpdate(id, { ...updates }, { new: true, runValidators: true }).populate('assignedTo', 'name email avatar')
            .populate('assignees', 'name email avatar')
            .populate('assignedBy', 'name email avatar')
            .populate('projectId', 'name color');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        try {
            const action = isNowCompleted && !wasCompleted ? 'task_completed' : 'task_updated';
            const metadata = {
                taskTitle: task.title,
                taskId: task._id.toString(),
            };
            if (updates.status || updates.listId) {
                metadata.oldStatus = existingTask.status;
                metadata.newStatus = task.status;
            }
            await AuditLog_1.AuditLog.logAction({
                projectId: existingTask.projectId.toString(),
                userId: req.user._id,
                action,
                entityType: 'task',
                entityId: task._id.toString(),
                metadata,
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, existingTask.projectId.toString(), 'task:updated', {
            task,
            updatedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        if (isNowCompleted && !wasCompleted) {
            (0, socketHandlers_1.broadcastToProject)(io, existingTask.projectId.toString(), 'performance:update', {
                projectId: existingTask.projectId.toString(),
                taskId: task._id,
                taskTitle: task.title,
                completedBy: req.user._id,
                completedByName: req.user.displayName,
                assignees: task.assignees,
                timestamp: new Date(),
                message: 'Task completed - performance metrics updated'
            });
            logger_1.logger.info(`Performance update triggered: Task ${task.title} completed by ${req.user.displayName}`);
        }
        logger_1.logger.info(`Task updated: ${task.title}`);
        return (0, responses_1.successResponse)(res, 'Task updated successfully', task);
    }
    catch (error) {
        logger_1.logger.error('Error updating task:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update task');
    }
};
exports.updateTask = updateTask;
const deleteTask = async (req, res) => {
    try {
        const { id } = req.params;
        const task = await models_1.Task.findById(id);
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await models_1.Project.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const projectId = task.projectId.toString();
        const taskTitle = task.title;
        await models_1.Task.findByIdAndDelete(id);
        await AuditLog_1.AuditLog.logAction({
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
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, projectId, 'task:deleted', {
            taskId: id,
            deletedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Task deleted: ${taskTitle}`);
        return (0, responses_1.successResponse)(res, 'Task deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting task:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete task');
    }
};
exports.deleteTask = deleteTask;
const reorderTasks = async (req, res) => {
    try {
        const { projectId, tasks } = req.body;
        if (!projectId) {
            return (0, responses_1.errorResponse)(res, 'Project ID is required', 400);
        }
        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            return (0, responses_1.errorResponse)(res, 'Tasks array is required', 400);
        }
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
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
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        await models_1.Task.reorderTasks(projectId, tasks.map((task) => ({
            _id: task.id,
            status: task.status,
            order: task.order
        })));
        logger_1.logger.info(`Tasks reordered in project: ${projectId}`);
        return (0, responses_1.successResponse)(res, 'Tasks reordered successfully');
    }
    catch (error) {
        logger_1.logger.error('Error reordering tasks:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to reorder tasks');
    }
};
exports.reorderTasks = reorderTasks;
//# sourceMappingURL=tasksController.js.map