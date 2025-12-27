"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTimeLog = exports.updateTimeLog = exports.getUserTimeLogs = exports.getProjectTimeLogs = exports.getTaskTimeLogs = exports.logTime = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const logTime = async (req, res) => {
    try {
        const { taskId, timeSpent, description, loggedAt } = req.body;
        if (!taskId || timeSpent === undefined) {
            return (0, responses_1.errorResponse)(res, 'Task ID and time spent are required', 400);
        }
        if (timeSpent < 0) {
            return (0, responses_1.errorResponse)(res, 'Time spent must be a positive number', 400);
        }
        const task = await models_1.Task.findById(taskId);
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await models_1.Project.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
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
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        if (!isMember && !isManager && !isOwner) {
            return (0, responses_1.errorResponse)(res, 'Access denied to this task', 403);
        }
        if (!isOwner && !isManager) {
            const isAssigned = task.assignees.some((assignee) => {
                const assigneeId = typeof assignee === 'object' && assignee._id
                    ? assignee._id.toString()
                    : assignee.toString();
                return assigneeId === req.user._id;
            });
            const isAssignedTo = task.assignedTo && task.assignedTo.toString() === req.user._id;
            if (!isAssigned && !isAssignedTo) {
                return (0, responses_1.errorResponse)(res, 'You can only log time for tasks assigned to you', 403);
            }
        }
        const timeLog = new models_1.TaskTimeLog({
            taskId,
            projectId: task.projectId,
            userId: req.user._id,
            timeSpent,
            description: description?.trim(),
            loggedAt: loggedAt ? new Date(loggedAt) : new Date()
        });
        await timeLog.save();
        await timeLog.populate('userId', 'displayName email photoURL');
        logger_1.logger.info(`Time logged: ${timeSpent} minutes for task ${taskId} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Time logged successfully', timeLog);
    }
    catch (error) {
        logger_1.logger.error('Error logging time:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to log time');
    }
};
exports.logTime = logTime;
const getTaskTimeLogs = async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = await models_1.Task.findById(taskId);
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await models_1.Project.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
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
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        if (!isMember && !isManager && !isOwner) {
            return (0, responses_1.errorResponse)(res, 'Access denied to this task', 403);
        }
        const timeLogs = await models_1.TaskTimeLog.findByTask(taskId);
        const totalTime = await models_1.TaskTimeLog.getTotalTimeByTask(taskId);
        return (0, responses_1.successResponse)(res, 'Time logs retrieved successfully', {
            timeLogs,
            totalTime
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting task time logs:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve time logs');
    }
};
exports.getTaskTimeLogs = getTaskTimeLogs;
const getProjectTimeLogs = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { startDate, endDate } = req.query;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
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
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        if (!isMember && !isManager && !isOwner) {
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;
        const timeLogs = await models_1.TaskTimeLog.findByProject(projectId, start, end);
        return (0, responses_1.successResponse)(res, 'Time logs retrieved successfully', timeLogs);
    }
    catch (error) {
        logger_1.logger.error('Error getting project time logs:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve time logs');
    }
};
exports.getProjectTimeLogs = getProjectTimeLogs;
const getUserTimeLogs = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;
        const timeLogs = await models_1.TaskTimeLog.findByUser(req.user._id, start, end);
        const totalTime = await models_1.TaskTimeLog.getTotalTimeByUser(req.user._id, start, end);
        return (0, responses_1.successResponse)(res, 'Time logs retrieved successfully', {
            timeLogs,
            totalTime
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting user time logs:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve time logs');
    }
};
exports.getUserTimeLogs = getUserTimeLogs;
const updateTimeLog = async (req, res) => {
    try {
        const { timeLogId } = req.params;
        const { timeSpent, description, loggedAt } = req.body;
        const timeLog = await models_1.TaskTimeLog.findById(timeLogId);
        if (!timeLog) {
            return (0, responses_1.notFoundResponse)(res, 'Time log not found');
        }
        if (timeLog.userId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'You can only update your own time logs', 403);
        }
        if (timeSpent !== undefined) {
            if (timeSpent < 0) {
                return (0, responses_1.errorResponse)(res, 'Time spent must be a positive number', 400);
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
        logger_1.logger.info(`Time log ${timeLogId} updated by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Time log updated successfully', timeLog);
    }
    catch (error) {
        logger_1.logger.error('Error updating time log:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update time log');
    }
};
exports.updateTimeLog = updateTimeLog;
const deleteTimeLog = async (req, res) => {
    try {
        const { timeLogId } = req.params;
        const timeLog = await models_1.TaskTimeLog.findById(timeLogId);
        if (!timeLog) {
            return (0, responses_1.notFoundResponse)(res, 'Time log not found');
        }
        if (timeLog.userId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'You can only delete your own time logs', 403);
        }
        await models_1.TaskTimeLog.findByIdAndDelete(timeLogId);
        logger_1.logger.info(`Time log ${timeLogId} deleted by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Time log deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting time log:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete time log');
    }
};
exports.deleteTimeLog = deleteTimeLog;
//# sourceMappingURL=timeTrackingController.js.map