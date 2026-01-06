"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTaskHistory = exports.reorderTasks = exports.deleteTask = exports.updateTask = exports.createTask = exports.getTask = exports.getTasks = void 0;
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
                    .populate('assignees', 'displayName email avatar photoURL')
                    .populate('assignedTo', 'displayName email avatar photoURL')
                    .populate('assignedBy', 'displayName email avatar photoURL')
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
                    .populate('assignees', 'displayName email avatar photoURL')
                    .populate('assignedTo', 'displayName email avatar photoURL')
                    .populate('assignedBy', 'displayName email avatar photoURL')
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
                .populate('assignees', 'displayName email avatar photoURL')
                .populate('assignedTo', 'displayName email avatar photoURL')
                .populate('assignedBy', 'displayName email avatar photoURL')
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
            .populate('assignees', 'displayName email avatar photoURL')
            .populate('assignedTo', 'displayName email avatar photoURL')
            .populate('assignedBy', 'displayName email avatar photoURL');
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
        await task.populate('assignedTo', 'displayName email avatar photoURL');
        await task.populate('assignees', 'displayName email avatar photoURL');
        await task.populate('assignedBy', 'displayName email avatar photoURL');
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
                    initialAssignees: task.assignees ? task.assignees.map((a) => a._id ? a._id.toString() : a.toString()) : [],
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
        const oldAssignees = existingTask.assignees ? existingTask.assignees.map((a) => a.toString()) : [];
        let newlyAssignedUsers = [];
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
            newlyAssignedUsers = validatedAssignees.filter((userId) => !oldAssignees.includes(userId));
        }
        if (updates.assignedTo && !updates.assignees) {
            if (!allValidUserIds.includes(updates.assignedTo)) {
                return (0, responses_1.errorResponse)(res, 'Assigned user is not a project member or manager', 400);
            }
            updates.assignees = [updates.assignedTo];
            if (!existingTask.assignedAt) {
                updates.assignedAt = new Date();
            }
            if (!oldAssignees.includes(updates.assignedTo)) {
                newlyAssignedUsers = [updates.assignedTo];
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
            const validFrequencies = ['none', '1hour', '3hours', '12hours', '24hours', '48hours'];
            if (!validFrequencies.includes(updates.reminderFrequency)) {
                return (0, responses_1.errorResponse)(res, 'Invalid reminder frequency', 400);
            }
        }
        const task = await models_1.Task.findByIdAndUpdate(id, { ...updates }, { new: true, runValidators: true }).populate('assignedTo', 'displayName email avatar photoURL')
            .populate('assignees', 'displayName email avatar photoURL')
            .populate('assignedBy', 'displayName email avatar photoURL')
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
            const currentAssignees = task.assignees ? task.assignees.map((a) => {
                return a._id ? a._id.toString() : a.toString();
            }) : [];
            const assigneesChanged = JSON.stringify(oldAssignees.sort()) !== JSON.stringify(currentAssignees.sort());
            if (assigneesChanged) {
                metadata.assigneesChanged = true;
                metadata.oldAssignees = oldAssignees;
                metadata.newAssignees = currentAssignees;
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
        const listChanged = updates.listId && updates.listId !== existingTask.listId;
        logger_1.logger.info(`Task update - listChanged: ${listChanged}, updates.listId: ${updates.listId}, existingTask.listId: ${existingTask.listId}`);
        if (listChanged) {
            try {
                const User = (await Promise.resolve().then(() => __importStar(require('../models/User')))).default;
                const projectWithColumns = await models_1.Project.findById(existingTask.projectId);
                logger_1.logger.info(`Project columns: ${JSON.stringify(projectWithColumns?.columns || [])}`);
                if (projectWithColumns) {
                    const targetColumn = projectWithColumns.columns.find((col) => col.id === updates.listId);
                    logger_1.logger.info(`Target column found: ${targetColumn ? targetColumn.title : 'NOT FOUND'}`);
                    logger_1.logger.info(`Target column assignedMembers: ${JSON.stringify(targetColumn?.assignedMembers || [])}`);
                    if (targetColumn) {
                        const memberEmails = [];
                        if (targetColumn.assignedMembers && targetColumn.assignedMembers.length > 0) {
                            const assignedMemberIds = targetColumn.assignedMembers.map((id) => id.toString());
                            const assignedMembersData = await User.find({
                                _id: { $in: assignedMemberIds }
                            }).select('email displayName');
                            logger_1.logger.info(`Found ${assignedMembersData.length} assigned members for the target column`);
                            assignedMembersData.forEach((member) => {
                                if (member.email && member.email !== req.user.email) {
                                    memberEmails.push(member.email);
                                }
                            });
                        }
                        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                        const isEmail = emailRegex.test(targetColumn.title);
                        if (isEmail) {
                            logger_1.logger.info(`List title "${targetColumn.title}" appears to be an email address`);
                            const userByEmail = await User.findOne({ email: targetColumn.title }).select('email displayName _id');
                            if (userByEmail) {
                                const isProjectMember = projectWithColumns.members.some((m) => m.toString() === userByEmail._id.toString()) ||
                                    projectWithColumns.managers?.some((m) => m.toString() === userByEmail._id.toString()) ||
                                    projectWithColumns.ownerId.toString() === userByEmail._id.toString();
                                if (isProjectMember && userByEmail.email !== req.user.email && !memberEmails.includes(userByEmail.email)) {
                                    memberEmails.push(userByEmail.email);
                                    logger_1.logger.info(`Added list title email "${userByEmail.email}" to notification recipients`);
                                }
                            }
                        }
                        else {
                            logger_1.logger.info(`List title "${targetColumn.title}" is not an email, checking if it's a username`);
                            const userByDisplayName = await User.findOne({ displayName: targetColumn.title }).select('email displayName _id');
                            if (userByDisplayName) {
                                logger_1.logger.info(`Found user with displayName "${targetColumn.title}": ${userByDisplayName.email}`);
                                const isProjectMember = projectWithColumns.members.some((m) => m.toString() === userByDisplayName._id.toString()) ||
                                    projectWithColumns.managers?.some((m) => m.toString() === userByDisplayName._id.toString()) ||
                                    projectWithColumns.ownerId.toString() === userByDisplayName._id.toString();
                                if (isProjectMember && userByDisplayName.email !== req.user.email && !memberEmails.includes(userByDisplayName.email)) {
                                    memberEmails.push(userByDisplayName.email);
                                    logger_1.logger.info(`Added username "${targetColumn.title}" (email: ${userByDisplayName.email}) to notification recipients`);
                                }
                            }
                            else {
                                logger_1.logger.info(`No user found with displayName "${targetColumn.title}"`);
                            }
                        }
                        logger_1.logger.info(`Member emails to notify: ${JSON.stringify(memberEmails)}`);
                        if (memberEmails.length > 0) {
                            const User = (await Promise.resolve().then(() => __importStar(require('../models/User')))).default;
                            const allUsers = await User.find({ email: { $in: memberEmails } }).select('_id email displayName settings');
                            const oldList = projectWithColumns.columns?.find((col) => col.id === existingTask.listId);
                            const usersWithEmailEnabled = allUsers.filter(user => {
                                const emailEnabled = user.settings?.notifications?.emailNotifications !== false;
                                const taskMovedEmailEnabled = user.settings?.notifications?.taskMovedEmail !== false;
                                return emailEnabled && taskMovedEmailEnabled;
                            });
                            const emailRecipients = usersWithEmailEnabled.map(u => u.email);
                            if (emailRecipients.length > 0) {
                                await emailService_1.emailService.sendTaskMovedToListNotification(emailRecipients, {
                                    taskTitle: task.title,
                                    taskId: task._id.toString(),
                                    projectName: projectWithColumns.name,
                                    projectId: projectWithColumns._id.toString(),
                                    listTitle: targetColumn.title,
                                    movedByName: req.user.displayName || req.user.email,
                                    priority: task.priority
                                });
                                logger_1.logger.info(`Sent list notification for task "${task.title}" moved to "${targetColumn.title}" to ${emailRecipients.length} members`);
                            }
                            const usersToNotify = allUsers;
                            usersToNotify.forEach(user => {
                                (0, socketHandlers_1.broadcastToUser)(io, user._id.toString(), 'notification:task:moved', {
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
                            logger_1.logger.info(`Sent real-time task moved notifications to ${usersToNotify.length} users`);
                            const { pushNotificationService } = await Promise.resolve().then(() => __importStar(require('../services/pushNotificationService')));
                            const usersWithPushEnabled = usersToNotify.filter(user => {
                                const pushEnabled = user.settings?.notifications?.pushNotifications !== false;
                                const taskMovedPushEnabled = user.settings?.notifications?.taskMovedPush !== false;
                                return pushEnabled && taskMovedPushEnabled;
                            });
                            for (const user of usersWithPushEnabled) {
                                try {
                                    await pushNotificationService.sendTaskMovedNotification(user._id.toString(), task.title, oldList?.title || existingTask.listId || existingTask.status, targetColumn.title, req.user.displayName || req.user.email, task.projectId.toString(), task._id.toString());
                                }
                                catch (pushError) {
                                    logger_1.logger.error(`Failed to send push notification to user ${user._id}:`, pushError);
                                }
                            }
                            logger_1.logger.info(`Sent push notifications for task moved to ${usersWithPushEnabled.length} users`);
                        }
                        else {
                            logger_1.logger.info(`No member emails to notify (all filtered out or empty)`);
                        }
                    }
                    else {
                        logger_1.logger.info(`Target column not found`);
                    }
                }
                else {
                    logger_1.logger.warn(`Project not found when trying to send list notification`);
                }
            }
            catch (emailError) {
                logger_1.logger.error('Error sending list notification email:', emailError);
            }
        }
        if (newlyAssignedUsers.length > 0) {
            try {
                logger_1.logger.info(`Sending assignment notifications to ${newlyAssignedUsers.length} newly assigned users`);
                const User = (await Promise.resolve().then(() => __importStar(require('../models/User')))).default;
                const users = await User.find({ _id: { $in: newlyAssignedUsers } }).select('email displayName settings');
                logger_1.logger.info(`Found ${users.length} users to notify: ${users.map(u => u.email).join(', ')}`);
                const recipientEmails = users
                    .filter(user => user._id.toString() !== req.user._id)
                    .filter(user => {
                    const emailEnabled = user.settings?.notifications?.emailNotifications !== false;
                    const taskAssignedEmailEnabled = user.settings?.notifications?.taskAssignedEmail !== false;
                    return emailEnabled && taskAssignedEmailEnabled;
                })
                    .map(user => user.email);
                if (recipientEmails.length > 0) {
                    await emailService_1.emailService.sendTaskAssignedNotification(recipientEmails, {
                        taskTitle: task.title,
                        taskId: task._id.toString(),
                        projectName: project.name,
                        projectId: project._id.toString(),
                        assignedByName: req.user.displayName || req.user.email,
                        priority: task.priority,
                        dueDate: task.dueDate
                    });
                    logger_1.logger.info(`Sent assignment notification for task "${task.title}" to ${recipientEmails.length} users: ${recipientEmails.join(', ')}`);
                }
                else {
                    logger_1.logger.info(`No users to notify (user assigned themselves or email notifications disabled)`);
                }
                const usersToNotify = users.filter(user => user._id.toString() !== req.user._id);
                usersToNotify.forEach(user => {
                    (0, socketHandlers_1.broadcastToUser)(io, user._id.toString(), 'notification:task:assigned', {
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
                logger_1.logger.info(`Sent real-time notifications to ${usersToNotify.length} users`);
                const { pushNotificationService } = await Promise.resolve().then(() => __importStar(require('../services/pushNotificationService')));
                const usersWithPushEnabled = usersToNotify.filter(user => {
                    const pushEnabled = user.settings?.notifications?.pushNotifications !== false;
                    const taskAssignedPushEnabled = user.settings?.notifications?.taskAssignedPush !== false;
                    return pushEnabled && taskAssignedPushEnabled;
                });
                for (const user of usersWithPushEnabled) {
                    try {
                        await pushNotificationService.sendTaskAssignedNotification(user._id.toString(), task.title, req.user.displayName || req.user.email, task.projectId.toString(), task._id.toString());
                    }
                    catch (pushError) {
                        logger_1.logger.error(`Failed to send push notification to user ${user._id}:`, pushError);
                    }
                }
                logger_1.logger.info(`Sent push notifications to ${usersWithPushEnabled.length} users`);
            }
            catch (emailError) {
                logger_1.logger.error('Error sending assignment notification emails:', emailError);
            }
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
        logger_1.logger.info('=== REORDER TASKS REQUEST ===');
        logger_1.logger.info(`Request body: ${JSON.stringify(req.body, null, 2)}`);
        logger_1.logger.info(`User: ${req.user?.email || 'unknown'}`);
        const { projectId, tasks } = req.body;
        if (!projectId) {
            logger_1.logger.error('Missing projectId in request');
            return (0, responses_1.errorResponse)(res, 'Project ID is required', 400);
        }
        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            logger_1.logger.error(`Invalid tasks array - tasks: ${JSON.stringify(tasks)}, isArray: ${Array.isArray(tasks)}, length: ${tasks?.length}`);
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
const getTaskHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const task = await models_1.Task.findById(id).populate('projectId');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = task.projectId;
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
            return (0, responses_1.errorResponse)(res, 'Access denied to this task', 403);
        }
        const history = await AuditLog_1.AuditLog.find({
            projectId: project._id,
            $or: [
                { entityId: id },
                { 'metadata.taskId': id }
            ]
        })
            .populate('userId', 'displayName email photoURL')
            .sort({ createdAt: -1 })
            .limit(100);
        const formattedHistory = history.map((log) => ({
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
        return (0, responses_1.successResponse)(res, 'Task history retrieved successfully', formattedHistory);
    }
    catch (error) {
        logger_1.logger.error('Error fetching task history:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to fetch task history');
    }
};
exports.getTaskHistory = getTaskHistory;
function getActionDescription(log) {
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
function extractChanges(metadata) {
    if (!metadata)
        return {};
    const changes = {};
    if (metadata.oldStatus && metadata.newStatus) {
        changes.status = {
            from: metadata.oldStatus,
            to: metadata.newStatus
        };
    }
    if (metadata.oldPriority && metadata.newPriority) {
        changes.priority = {
            from: metadata.oldPriority,
            to: metadata.newPriority
        };
    }
    if (metadata.oldAssignee || metadata.newAssignee) {
        changes.assignee = {
            from: metadata.oldAssignee || 'None',
            to: metadata.newAssignee || 'None'
        };
    }
    if (metadata.changes) {
        Object.assign(changes, metadata.changes);
    }
    return changes;
}
//# sourceMappingURL=tasksController.js.map