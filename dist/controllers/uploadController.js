"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadChatAttachment = exports.getTaskAttachments = exports.deleteTaskAttachment = exports.uploadTaskAttachment = void 0;
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const Task_1 = __importDefault(require("../models/Task"));
const Project_1 = __importDefault(require("../models/Project"));
const ChatGroup_1 = require("../models/ChatGroup");
const mongoose_1 = __importDefault(require("mongoose"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const getBaseUrl = (req) => {
    if (process.env.API_URL) {
        return process.env.API_URL;
    }
    const protocol = req.protocol;
    const host = req.get('host');
    return `${protocol}://${host}`;
};
const uploadTaskAttachment = async (req, res) => {
    try {
        const { taskId } = req.params;
        logger_1.logger.info(`📤 Upload request received for task: ${taskId}`);
        logger_1.logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
        logger_1.logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);
        if (!req.file) {
            logger_1.logger.error('❌ Upload failed: No file uploaded');
            res.status(400).json({ success: false, message: 'No file uploaded' });
            return;
        }
        if (!taskId || taskId === 'undefined' || taskId === 'null') {
            logger_1.logger.error(`❌ Upload failed: Invalid task ID - ${taskId}`);
            res.status(400).json({ success: false, message: 'Invalid task ID' });
            return;
        }
        logger_1.logger.info(`🔍 Looking up task: ${taskId}`);
        const task = await Task_1.default.findById(taskId).populate('projectId');
        if (!task) {
            logger_1.logger.error(`❌ Upload failed: Task not found - ${taskId}`);
            res.status(404).json({ success: false, message: `Task not found with ID: ${taskId}` });
            return;
        }
        logger_1.logger.info(`✅ Task found: ${task.title}`);
        const project = await Project_1.default.findById(task.projectId);
        if (!project) {
            logger_1.logger.error(`❌ Upload failed: Project not found`);
            res.status(404).json({ success: false, message: 'Project not found' });
            return;
        }
        logger_1.logger.info(`✅ Project found: ${project.name}`);
        if (!req.user || !req.user._id) {
            logger_1.logger.error('❌ Upload failed: User not authenticated');
            res.status(401).json({ success: false, message: 'Authentication required' });
            return;
        }
        const userId = req.user._id.toString();
        const isOwner = project.ownerId.toString() === userId;
        const isMember = project.members.some((m) => m.toString() === userId);
        const isManager = project.managers?.some((m) => m.toString() === userId);
        if (!isOwner && !isMember && !isManager) {
            res.status(403).json({ success: false, message: 'Access denied' });
            return;
        }
        const file = req.file;
        const fileId = (0, uuid_1.v4)();
        const baseUrl = getBaseUrl(req);
        const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;
        logger_1.logger.info(`📦 File saved to disk: ${file.path}`);
        logger_1.logger.info(`🔗 Public URL: ${publicUrl}`);
        const attachment = {
            id: fileId,
            name: file.originalname,
            url: publicUrl,
            type: file.mimetype,
            size: file.size,
            uploadedBy: new mongoose_1.default.Types.ObjectId(req.user._id),
            uploadedAt: new Date()
        };
        task.attachments.push(attachment);
        await task.save();
        logger_1.logger.info(`✅ File uploaded successfully: ${file.filename}`);
        res.json({
            success: true,
            message: 'File uploaded successfully',
            attachment
        });
    }
    catch (error) {
        logger_1.logger.error('❌ Error in uploadTaskAttachment:', error);
        const errorMessage = error instanceof Error ? error.message : 'Server error';
        logger_1.logger.error(`Error details: ${errorMessage}`);
        res.status(500).json({
            success: false,
            message: `Upload failed: ${errorMessage}`
        });
    }
};
exports.uploadTaskAttachment = uploadTaskAttachment;
const deleteTaskAttachment = async (req, res) => {
    try {
        const { taskId, attachmentId } = req.params;
        const task = await Task_1.default.findById(taskId).populate('projectId');
        if (!task) {
            res.status(404).json({ success: false, message: 'Task not found' });
            return;
        }
        const project = await Project_1.default.findById(task.projectId);
        if (!project) {
            res.status(404).json({ success: false, message: 'Project not found' });
            return;
        }
        const userId = req.user._id.toString();
        const isOwner = project.ownerId.toString() === userId;
        const isManager = project.managers?.some((m) => m.toString() === userId);
        const attachment = task.attachments.find((a) => a.id === attachmentId);
        if (!attachment) {
            res.status(404).json({ success: false, message: 'Attachment not found' });
            return;
        }
        const isUploader = attachment.uploadedBy.toString() === userId;
        if (!isOwner && !isManager && !isUploader) {
            res.status(403).json({ success: false, message: 'Access denied' });
            return;
        }
        try {
            const urlParts = attachment.url.split('/');
            const filename = urlParts[urlParts.length - 1];
            const filePath = path_1.default.join(process.cwd(), 'uploads', 'task-attachments', filename);
            if (fs_1.default.existsSync(filePath)) {
                fs_1.default.unlinkSync(filePath);
                logger_1.logger.info(`Deleted file from storage: ${filePath}`);
            }
            else {
                logger_1.logger.warn(`File not found in storage: ${filePath}`);
            }
        }
        catch (error) {
            logger_1.logger.warn(`Error deleting file from storage:`, error);
        }
        task.attachments = task.attachments.filter((a) => a.id !== attachmentId);
        await task.save();
        res.json({
            success: true,
            message: 'Attachment deleted successfully'
        });
    }
    catch (error) {
        logger_1.logger.error('Error in deleteTaskAttachment:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
exports.deleteTaskAttachment = deleteTaskAttachment;
const getTaskAttachments = async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = await Task_1.default.findById(taskId).populate('attachments.uploadedBy', 'name email avatar');
        if (!task) {
            res.status(404).json({ success: false, message: 'Task not found' });
            return;
        }
        res.json({
            success: true,
            attachments: task.attachments
        });
    }
    catch (error) {
        logger_1.logger.error('Error in getTaskAttachments:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
exports.getTaskAttachments = getTaskAttachments;
const uploadChatAttachment = async (req, res) => {
    try {
        const { groupId } = req.params;
        logger_1.logger.info(`📤 Chat upload request received for group: ${groupId}`);
        logger_1.logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
        logger_1.logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);
        if (!req.file) {
            logger_1.logger.error('❌ Upload failed: No file uploaded');
            res.status(400).json({ success: false, message: 'No file uploaded' });
            return;
        }
        if (!groupId || groupId === 'undefined' || groupId === 'null') {
            logger_1.logger.error(`❌ Upload failed: Invalid group ID - ${groupId}`);
            res.status(400).json({ success: false, message: 'Invalid group ID' });
            return;
        }
        logger_1.logger.info(`🔍 Looking up chat group: ${groupId}`);
        const chatGroup = await ChatGroup_1.ChatGroup.findOne({
            _id: groupId,
            members: req.user?._id,
            isActive: true
        });
        if (!chatGroup) {
            logger_1.logger.error(`❌ Upload failed: Group not found or access denied - ${groupId}`);
            res.status(403).json({ success: false, message: 'Not authorized to upload to this group' });
            return;
        }
        logger_1.logger.info(`✅ Chat group found: ${chatGroup.name}`);
        const file = req.file;
        const baseUrl = getBaseUrl(req);
        const publicUrl = `${baseUrl}/uploads/chat-attachments/${file.filename}`;
        logger_1.logger.info(`📦 Chat file saved to disk: ${file.path}`);
        logger_1.logger.info(`🔗 Public URL: ${publicUrl}`);
        const attachment = {
            fileName: file.originalname,
            fileUrl: publicUrl,
            fileType: file.mimetype,
            fileSize: file.size
        };
        logger_1.logger.info(`✅ Chat file uploaded successfully: ${file.filename}`);
        res.json({
            success: true,
            message: 'File uploaded successfully',
            attachment
        });
    }
    catch (error) {
        logger_1.logger.error('❌ Error in uploadChatAttachment:', error);
        const errorMessage = error instanceof Error ? error.message : 'Server error';
        logger_1.logger.error(`Error details: ${errorMessage}`);
        res.status(500).json({
            success: false,
            message: `Upload failed: ${errorMessage}`
        });
    }
};
exports.uploadChatAttachment = uploadChatAttachment;
//# sourceMappingURL=uploadController.js.map