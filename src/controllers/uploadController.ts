import { Request, Response } from 'express';
import { bucket } from '../config/firebase';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import Task from '../models/Task';
import Project from '../models/Project';
import mongoose from 'mongoose';

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
    const fileName = `task-attachments/${taskId}/${fileId}-${file.originalname}`;

    // Upload to Firebase Storage
    const fileUpload = bucket.file(fileName);
    const stream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype,
        metadata: {
          uploadedBy: userId,
          taskId: taskId,
          originalName: file.originalname
        }
      }
    });

    stream.on('error', (error) => {
      logger.error('Error uploading file to Firebase:', error);
      res.status(500).json({ success: false, message: 'Failed to upload file' });
    });

    stream.on('finish', async () => {
      // Make file publicly accessible
      await fileUpload.makePublic();

      // Get public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

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

      logger.info(`File uploaded successfully: ${fileName}`);
      res.json({
        success: true,
        message: 'File uploaded successfully',
        attachment
      });
    });

    stream.end(file.buffer);
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

    // Delete from Firebase Storage
    const fileName = `task-attachments/${taskId}/${attachmentId}-${attachment.name}`;
    try {
      await bucket.file(fileName).delete();
      logger.info(`Deleted file from storage: ${fileName}`);
    } catch (error) {
      logger.warn(`File not found in storage: ${fileName}`, error);
      // Continue even if file doesn't exist in storage
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
