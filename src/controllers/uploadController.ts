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
import { encryptField, decryptField, decryptProjectFields } from '../utils/fieldEncryption';

/**
 * Get the base URL for file serving
 */
const getBaseUrl = (req: Request): string => {
  // Use environment variable if set (prefer FILE_SERVE_URL, fallback to API_URL)
  if (process.env.FILE_SERVE_URL) {
    return process.env.FILE_SERVE_URL;
  }
  if (process.env.API_URL) {
    return process.env.API_URL;
  }
  // Construct from request - keep the port for local development
  const protocol = req.protocol;
  const host = req.get('host') || 'localhost:3001';
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
    // task is saved again below (adding the attachment), so its title is decrypted
    // into a local var rather than mutated in place — mutating in place here would
    // persist the decrypted plaintext back over the ciphertext on save.
    logger.info(`✅ Task found: ${decryptField(task.title, taskId)}`);

    const project = await Project.findById(task.projectId);
    if (!project) {
      logger.error(`❌ Upload failed: Project not found`);
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }
    decryptProjectFields(project as any);
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

    // Add attachment to task. `attachment` (plaintext url) is what's returned to the
    // client below; a separate copy with the url encrypted is what's persisted —
    // this avoids ever needing to decrypt-after-save on the response object.
    const attachment = {
      id: fileId,
      name: file.originalname,
      url: publicUrl,
      type: file.mimetype,
      size: file.size,
      uploadedBy: new mongoose.Types.ObjectId(req.user._id),
      uploadedAt: new Date()
    };

    task.attachments.push({ ...attachment, url: encryptField(publicUrl, taskId) } as any);
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
      // url is encrypted at rest — decrypt into a local var before splitting it,
      // since base64 ciphertext legitimately contains '/' characters and would
      // otherwise silently produce a bogus filename.
      const decryptedUrl = decryptField(attachment.url, taskId) || '';
      const urlParts = decryptedUrl.split('/');
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

    task.attachments.forEach((a: any) => {
      if (a.url) a.url = decryptField(a.url, taskId);
    });

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
 * Upload attachment to a specific subtask
 */
export const uploadSubtaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, subtaskId } = req.params;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

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

    if (!req.user?._id) {
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

    const subtask = (task.subtasks as any[]).find((s) => s.id === subtaskId);
    if (!subtask) {
      res.status(404).json({ success: false, message: 'Subtask not found' });
      return;
    }

    const file = req.file;
    const fileId = uuidv4();
    const baseUrl = getBaseUrl(req);
    const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;

    // attachment (plaintext url) is returned to the client below; the encrypted
    // copy pushed onto the subtask is keyed by the parent TASK's id, not the
    // subtask's own id — same convention as subtask titles/comments.
    const attachment = {
      id: fileId,
      name: file.originalname,
      url: publicUrl,
      type: file.mimetype,
      size: file.size,
      uploadedBy: new mongoose.Types.ObjectId(req.user._id),
      uploadedAt: new Date()
    };

    if (!subtask.attachments) subtask.attachments = [];
    subtask.attachments.push({ ...attachment, url: encryptField(publicUrl, taskId) });
    task.markModified('subtasks');
    await task.save();

    logger.info(`✅ Subtask attachment uploaded: ${file.filename}`);
    res.json({ success: true, message: 'File uploaded successfully', attachment });
  } catch (error) {
    logger.error('❌ Error in uploadSubtaskAttachment:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

/**
 * Delete attachment from a subtask
 */
export const deleteSubtaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, subtaskId, attachmentId } = req.params;

    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const subtask = (task.subtasks as any[]).find((s) => s.id === subtaskId);
    if (!subtask) {
      res.status(404).json({ success: false, message: 'Subtask not found' });
      return;
    }

    const attachment = (subtask.attachments || []).find((a: any) => a.id === attachmentId);
    if (!attachment) {
      res.status(404).json({ success: false, message: 'Attachment not found' });
      return;
    }

    // Delete file from disk — url is encrypted at rest (keyed by the parent task's
    // id), decrypt before splitting since base64 ciphertext contains '/' characters.
    try {
      const decryptedUrl = decryptField(attachment.url, taskId) || '';
      const filename = decryptedUrl.split('/').pop();
      const filePath = path.join(process.cwd(), 'uploads', 'task-attachments', filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* continue if file missing */ }

    subtask.attachments = (subtask.attachments || []).filter((a: any) => a.id !== attachmentId);
    task.markModified('subtasks');
    await task.save();

    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (error) {
    logger.error('Error in deleteSubtaskAttachment:', error);
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

    // Optional client-supplied duration (seconds) for voice/audio/video attachments —
    // multer puts non-file multipart fields on req.body alongside the file.
    const parsedDuration = parseFloat(req.body?.duration);

    // Return attachment info
    const attachment: Record<string, unknown> = {
      fileName: file.originalname,
      fileUrl: publicUrl,
      fileType: file.mimetype,
      fileSize: file.size,
      mimeType: file.mimetype
    };
    if (!isNaN(parsedDuration) && parsedDuration > 0) {
      attachment.duration = parsedDuration;
    }

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

/**
 * Upload file for a support ticket or reply
 */
export const uploadSupportAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const file = req.file;
    const baseUrl = getBaseUrl(req);
    const publicUrl = `${baseUrl}/uploads/support-attachments/${file.filename}`;

    const attachment = {
      id: uuidv4(),
      name: file.originalname,
      url: publicUrl,
      type: file.mimetype,
      size: file.size,
    };

    res.json({ success: true, attachment });
  } catch (error) {
    logger.error('Error in uploadSupportAttachment:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};
