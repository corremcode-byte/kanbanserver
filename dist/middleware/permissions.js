"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTaskAccess = exports.checkCanDeleteTask = exports.checkCanEditTask = exports.checkPermission = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const checkPermission = (permission) => {
    return async (req, res, next) => {
        try {
            const userId = req.user?._id;
            if (!userId) {
                return (0, responses_1.errorResponse)(res, 'Unauthorized', 401);
            }
            let projectId;
            projectId = req.params.projectId || req.params.id;
            if (!projectId && req.body.projectId) {
                projectId = req.body.projectId;
            }
            if (!projectId) {
                return (0, responses_1.errorResponse)(res, 'Project ID not found', 400);
            }
            const task = await models_1.Task.findById(projectId);
            if (task) {
                projectId = task.projectId.toString();
            }
            if (!projectId) {
                return (0, responses_1.errorResponse)(res, 'Project ID not found', 400);
            }
            const project = await models_1.Project.findById(projectId);
            if (!project) {
                return (0, responses_1.errorResponse)(res, 'Project not found', 404);
            }
            const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
                ? project.ownerId._id.toString()
                : project.ownerId.toString();
            const isOwner = ownerId === userId;
            const isInOwners = project.owners && project.owners.some((owner) => {
                const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
                return owId === userId;
            });
            if (isOwner || isInOwners) {
                return next();
            }
            const userPermission = await models_1.ProjectPermission.findOne({
                projectId,
                userId
            });
            if (!userPermission) {
                return (0, responses_1.errorResponse)(res, 'You are not a member of this project', 403);
            }
            if (!userPermission.permissions[permission]) {
                return (0, responses_1.errorResponse)(res, `You don't have permission to ${permission.replace('can', '').toLowerCase()}`, 403);
            }
            next();
        }
        catch (error) {
            console.error('Permission middleware error:', error);
            return (0, responses_1.errorResponse)(res, 'Permission check failed', 500);
        }
    };
};
exports.checkPermission = checkPermission;
const checkCanEditTask = async (req, res, next) => {
    try {
        const userId = req.user?._id;
        const taskId = req.params.id;
        if (!userId || !taskId) {
            return (0, responses_1.errorResponse)(res, 'Invalid request', 400);
        }
        const task = await models_1.Task.findById(taskId);
        if (!task) {
            return (0, responses_1.errorResponse)(res, 'Task not found', 404);
        }
        const projectId = task.projectId.toString();
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.errorResponse)(res, 'Project not found', 404);
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === userId;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === userId;
        });
        if (isOwner || isInOwners) {
            return next();
        }
        const isAssigned = task.assignees && task.assignees.some((assignee) => {
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
        if (isAssigned) {
            console.log('User is assigned - allowing edit');
            return next();
        }
        const userPermission = await models_1.ProjectPermission.findOne({
            projectId,
            userId
        });
        if (!userPermission) {
            return (0, responses_1.errorResponse)(res, 'You are not a member of this project', 403);
        }
        if (!userPermission.permissions.canEditTasks) {
            return (0, responses_1.errorResponse)(res, 'You don\'t have permission to edit tasks', 403);
        }
        if (userPermission.permissions.canViewAllTasks) {
            return next();
        }
        return (0, responses_1.errorResponse)(res, 'You can only edit tasks assigned to you', 403);
    }
    catch (error) {
        console.error('Task edit check error:', error);
        return (0, responses_1.errorResponse)(res, 'Permission check failed', 500);
    }
};
exports.checkCanEditTask = checkCanEditTask;
const checkCanDeleteTask = async (req, res, next) => {
    try {
        const userId = req.user?._id;
        const taskId = req.params.id;
        if (!userId || !taskId) {
            return (0, responses_1.errorResponse)(res, 'Invalid request', 400);
        }
        const task = await models_1.Task.findById(taskId);
        if (!task) {
            return (0, responses_1.errorResponse)(res, 'Task not found', 404);
        }
        const projectId = task.projectId.toString();
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.errorResponse)(res, 'Project not found', 404);
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === userId;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === userId;
        });
        if (isOwner || isInOwners) {
            return next();
        }
        const userPermission = await models_1.ProjectPermission.findOne({
            projectId,
            userId
        });
        if (!userPermission) {
            return (0, responses_1.errorResponse)(res, 'You are not a member of this project', 403);
        }
        if (!userPermission.permissions.canDeleteTasks) {
            return (0, responses_1.errorResponse)(res, 'You don\'t have permission to delete tasks', 403);
        }
        next();
    }
    catch (error) {
        console.error('Task delete check error:', error);
        return (0, responses_1.errorResponse)(res, 'Permission check failed', 500);
    }
};
exports.checkCanDeleteTask = checkCanDeleteTask;
exports.checkTaskAccess = exports.checkCanEditTask;
//# sourceMappingURL=permissions.js.map