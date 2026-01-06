"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getComments = exports.deleteComment = exports.updateComment = exports.addComment = void 0;
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const Task_1 = __importDefault(require("../models/Task"));
const Project_1 = __importDefault(require("../models/Project"));
const responses_1 = require("../utils/responses");
const AuditLog_1 = require("../models/AuditLog");
const socket_1 = require("../socket");
const socketHandlers_1 = require("../socket/socketHandlers");
const addComment = async (req, res) => {
    try {
        const { taskId } = req.params;
        const { text } = req.body;
        if (!text || !text.trim()) {
            return (0, responses_1.errorResponse)(res, 'Comment text is required', 400);
        }
        const task = await Task_1.default.findById(taskId).populate('projectId');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await Project_1.default.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const userId = req.user._id.toString();
        const isOwner = project.ownerId.toString() === userId;
        const isMember = project.members.some((m) => m.toString() === userId);
        const isManager = project.managers?.some((m) => m.toString() === userId);
        if (!isOwner && !isMember && !isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project members can comment', 403);
        }
        const comment = {
            id: (0, uuid_1.v4)(),
            text: text.trim(),
            createdBy: req.user._id,
            createdAt: new Date()
        };
        task.comments.push(comment);
        await task.save();
        await task.populate('comments.createdBy', 'displayName email avatar photoURL');
        try {
            await AuditLog_1.AuditLog.logAction({
                projectId: task.projectId.toString(),
                userId: req.user._id,
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
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, task.projectId.toString(), 'comment:added', {
            taskId: task._id,
            comment,
            createdBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Comment added to task ${task.title} by ${req.user.displayName}`);
        const createdComment = task.comments.find((c) => c.id === comment.id);
        return (0, responses_1.successResponse)(res, 'Comment added successfully', createdComment);
    }
    catch (error) {
        logger_1.logger.error('Error adding comment:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to add comment');
    }
};
exports.addComment = addComment;
const updateComment = async (req, res) => {
    try {
        const { taskId, commentId } = req.params;
        const { text } = req.body;
        if (!text || !text.trim()) {
            return (0, responses_1.errorResponse)(res, 'Comment text is required', 400);
        }
        const task = await Task_1.default.findById(taskId);
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const comment = task.comments.find((c) => c.id === commentId);
        if (!comment) {
            return (0, responses_1.notFoundResponse)(res, 'Comment not found');
        }
        const userId = req.user._id.toString();
        if (comment.createdBy.toString() !== userId) {
            return (0, responses_1.errorResponse)(res, 'Only the comment creator can update it', 403);
        }
        comment.text = text.trim();
        comment.updatedAt = new Date();
        await task.save();
        await task.populate('comments.createdBy', 'displayName email avatar photoURL');
        try {
            await AuditLog_1.AuditLog.logAction({
                projectId: task.projectId.toString(),
                userId: req.user._id,
                action: 'comment_updated',
                entityType: 'task',
                entityId: task._id.toString(),
                metadata: {
                    taskTitle: task.title,
                    commentId: comment.id
                }
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, task.projectId.toString(), 'comment:updated', {
            taskId: task._id,
            comment,
            updatedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Comment updated on task ${task.title}`);
        const updatedComment = task.comments.find((c) => c.id === commentId);
        return (0, responses_1.successResponse)(res, 'Comment updated successfully', updatedComment);
    }
    catch (error) {
        logger_1.logger.error('Error updating comment:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update comment');
    }
};
exports.updateComment = updateComment;
const deleteComment = async (req, res) => {
    try {
        const { taskId, commentId } = req.params;
        const task = await Task_1.default.findById(taskId).populate('projectId');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const comment = task.comments.find((c) => c.id === commentId);
        if (!comment) {
            return (0, responses_1.notFoundResponse)(res, 'Comment not found');
        }
        const project = await Project_1.default.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const userId = req.user._id.toString();
        const isOwner = project.ownerId.toString() === userId;
        const isManager = project.managers?.some((m) => m.toString() === userId);
        const isCommentCreator = comment.createdBy.toString() === userId;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isManager && !isCommentCreator && !isAdmin) {
            return (0, responses_1.errorResponse)(res, 'Only project owner, admin, manager, or comment creator can delete comments', 403);
        }
        task.comments = task.comments.filter((c) => c.id !== commentId);
        await task.save();
        try {
            await AuditLog_1.AuditLog.logAction({
                projectId: task.projectId.toString(),
                userId: req.user._id,
                action: 'comment_deleted',
                entityType: 'task',
                entityId: task._id.toString(),
                metadata: {
                    taskTitle: task.title,
                    commentId: comment.id
                }
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, task.projectId.toString(), 'comment:deleted', {
            taskId: task._id,
            commentId,
            deletedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Comment deleted from task ${task.title}`);
        return (0, responses_1.successResponse)(res, 'Comment deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting comment:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete comment');
    }
};
exports.deleteComment = deleteComment;
const getComments = async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = await Task_1.default.findById(taskId)
            .populate('comments.createdBy', 'displayName email avatar photoURL');
        if (!task) {
            return (0, responses_1.notFoundResponse)(res, 'Task not found');
        }
        const project = await Project_1.default.findById(task.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const userId = req.user._id.toString();
        const isOwner = project.ownerId.toString() === userId;
        const isMember = project.members.some((m) => m.toString() === userId);
        const isManager = project.managers?.some((m) => m.toString() === userId);
        if (!isOwner && !isMember && !isManager) {
            return (0, responses_1.errorResponse)(res, 'Access denied', 403);
        }
        const comments = task.comments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return (0, responses_1.successResponse)(res, 'Comments retrieved successfully', comments);
    }
    catch (error) {
        logger_1.logger.error('Error getting comments:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get comments');
    }
};
exports.getComments = getComments;
//# sourceMappingURL=commentsController.js.map