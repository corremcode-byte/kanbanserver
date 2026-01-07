import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import Task from '../models/Task';
import Project from '../models/Project';
import { ChatGroup } from '../models/ChatGroup';
import { AuthenticatedRequest } from '../middleware/auth';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';

/**
 * Get the base URL for file serving
 */
const getBaseUrl = (req: Request): string => {
  // Use environment variable if set, otherwise construct from request
  if (process.env.API_URL) {
    return process.env.API_URL;
  }
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}`;
};

/**
 * Upload file to Firebase Storage and attach to task
 */
export const uploadTaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;

    logger.info(`📤 Upload request received for task: ${taskId}`);
    logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
    logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);

    if (!req.file) {
      logger.error('❌ Upload failed: No file uploaded');
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    // Validate taskId
    if (!taskId || taskId === 'undefined' || taskId === 'null') {
      logger.error(`❌ Upload failed: Invalid task ID - ${taskId}`);
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    // Find task and verify user has permission
    logger.info(`🔍 Looking up task: ${taskId}`);
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      logger.error(`❌ Upload failed: Task not found - ${taskId}`);
      res.status(404).json({ success: false, message: `Task not found with ID: ${taskId}` });
      return;
    }
    logger.info(`✅ Task found: ${task.title}`);

    const project = await Project.findById(task.projectId);
    if (!project) {
      logger.error(`❌ Upload failed: Project not found`);
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }
    logger.info(`✅ Project found: ${project.name}`);

    // Check if user is owner, manager, or member of the project
    if (!req.user || !req.user._id) {
      logger.error('❌ Upload failed: User not authenticated');
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    const isOwner = project.ownerId.toString() === userId;
    const isMember = project.members.some((m: any) => m.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);

    if (!isOwner && !isMember && !isManager) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const file = req.file;
    const fileId = uuidv4();

    // File is already saved by multer to disk
    // Construct the public URL
    const baseUrl = getBaseUrl(req);
    const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;

    logger.info(`📦 File saved to disk: ${file.path}`);
    logger.info(`🔗 Public URL: ${publicUrl}`);

    // Add attachment to task
    const attachment = {
      id: fileId,
      name: file.originalname,
      url: publicUrl,
      type: file.mimetype,
      size: file.size,
      uploadedBy: new mongoose.Types.ObjectId(req.user._id),
      uploadedAt: new Date()
    };

    task.attachments.push(attachment);
    await task.save();

    logger.info(`✅ File uploaded successfully: ${file.filename}`);
    res.json({
      success: true,
      message: 'File uploaded successfully',
      attachment
    });
  } catch (error) {
    logger.error('❌ Error in uploadTaskAttachment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Server error';
    logger.error(`Error details: ${errorMessage}`);
    res.status(500).json({
      success: false,
      message: `Upload failed: ${errorMessage}`
    });
  }
};

/**
 * Delete attachment from task and Firebase Storage
 */
export const deleteTaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, attachmentId } = req.params;

    // Find task
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const project = await Project.findById(task.projectId);
    if (!project) {
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }

    // Check permissions
    const userId = req.user._id.toString();
    const isOwner = project.ownerId.toString() === userId;
    const isManager = project.managers?.some((m: any) => m.toString() === userId);

    // Find attachment
    const attachment = task.attachments.find((a: any) => a.id === attachmentId);
    if (!attachment) {
      res.status(404).json({ success: false, message: 'Attachment not found' });
      return;
    }

    // Only owner, manager, or the uploader can delete
    const isUploader = attachment.uploadedBy.toString() === userId;
    if (!isOwner && !isManager && !isUploader) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    // Delete from filesystem
    try {
      // Extract filename from URL
      const urlParts = attachment.url.split('/');
      const filename = urlParts[urlParts.length - 1];
      const filePath = path.join(process.cwd(), 'uploads', 'task-attachments', filename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Deleted file from storage: ${filePath}`);
      } else {
        logger.warn(`File not found in storage: ${filePath}`);
      }
    } catch (error) {
      logger.warn(`Error deleting file from storage:`, error);
      // Continue even if file doesn't exist
    }

    // Remove from task attachments
    task.attachments = task.attachments.filter((a: any) => a.id !== attachmentId);
    await task.save();

    res.json({
      success: true,
      message: 'Attachment deleted successfully'
    });
  } catch (error) {
    logger.error('Error in deleteTaskAttachment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Get all attachments for a task
 */
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId).populate('attachments.uploadedBy', 'name email avatar');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    res.json({
      success: true,
      attachments: task.attachments
    });
  } catch (error) {
    logger.error('Error in getTaskAttachments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Upload file to VPS storage for chat attachment
 */
export const uploadChatAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { groupId } = req.params;

    logger.info(`📤 Chat upload request received for group: ${groupId}`);
    logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
    logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);

    if (!req.file) {
      logger.error('❌ Upload failed: No file uploaded');
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    // Validate groupId
    if (!groupId || groupId === 'undefined' || groupId === 'null') {
      logger.error(`❌ Upload failed: Invalid group ID - ${groupId}`);
      res.status(400).json({ success: false, message: 'Invalid group ID' });
      return;
    }

    // Find group and verify user is a member
    logger.info(`🔍 Looking up chat group: ${groupId}`);
    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: req.user?._id,
      isActive: true
    });

    if (!chatGroup) {
      logger.error(`❌ Upload failed: Group not found or access denied - ${groupId}`);
      res.status(403).json({ success: false, message: 'Not authorized to upload to this group' });
      return;
    }
    logger.info(`✅ Chat group found: ${chatGroup.name}`);

    const file = req.file;

    // File is already saved by multer to disk
    // Construct the public URL
    const baseUrl = getBaseUrl(req);
    const publicUrl = `${baseUrl}/uploads/chat-attachments/${file.filename}`;

    logger.info(`📦 Chat file saved to disk: ${file.path}`);
    logger.info(`🔗 Public URL: ${publicUrl}`);

    // Return attachment info
    const attachment = {
      fileName: file.originalname,
      fileUrl: publicUrl,
      fileType: file.mimetype,
      fileSize: file.size
    };

    logger.info(`✅ Chat file uploaded successfully: ${file.filename}`);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      attachment
    });
  } catch (error) {
    logger.error('❌ Error in uploadChatAttachment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Server error';
    logger.error(`Error details: ${errorMessage}`);
    res.status(500).json({
      success: false,
      message: `Upload failed: ${errorMessage}`
    });
  }
};
