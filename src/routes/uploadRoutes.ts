import express, { Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { uploadTaskAttachment as uploadTaskMiddleware, uploadChatAttachment as uploadChatMiddleware, uploadSupportAttachment as uploadSupportMiddleware, uploadNoteAttachment as uploadNoteMiddleware } from '../middleware/upload';
import {
  uploadTaskAttachment,
  deleteTaskAttachment,
  getTaskAttachments,
  uploadSubtaskAttachment,
  deleteSubtaskAttachment,
  uploadChatAttachment,
  uploadSupportAttachment,
  uploadNoteAttachment,
  getNoteAttachments,
  deleteNoteAttachment
} from '../controllers/uploadController';
import { MulterError } from 'multer';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Multer error handler
const handleMulterError = (err: any, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      // Chat allows larger files (videos) than task/support attachments — keep in
      // sync with the fileSize limits configured in middleware/upload.ts.
      const maxSizeLabel = req.path.startsWith('/chat/') ? '500MB' : '50MB';
      res.status(400).json({
        success: false,
        message: `File size must be less than ${maxSizeLabel}`
      });
      return;
    }
    res.status(400).json({
      success: false,
      message: err.message
    });
    return;
  }

  if (err) {
    res.status(400).json({
      success: false,
      message: err.message || 'File upload failed'
    });
    return;
  }

  next();
};

/**
 * @route   POST /api/upload/task/:taskId
 * @desc    Upload attachment to task
 * @access  Private (project members/managers/owners)
 */
router.post('/task/:taskId', uploadTaskMiddleware.single('file'), handleMulterError, uploadTaskAttachment);

/**
 * @route   GET /api/upload/task/:taskId/attachments
 * @desc    Get all attachments for a task
 * @access  Private
 */
router.get('/task/:taskId/attachments', getTaskAttachments);

/**
 * @route   DELETE /api/upload/task/:taskId/attachment/:attachmentId
 * @desc    Delete attachment from task
 * @access  Private (owner/manager/uploader only)
 */
router.delete('/task/:taskId/attachment/:attachmentId', deleteTaskAttachment);

/**
 * @route   POST /api/upload/task/:taskId/subtask/:subtaskId
 * @desc    Upload attachment to a subtask
 * @access  Private (project members)
 */
router.post('/task/:taskId/subtask/:subtaskId', uploadTaskMiddleware.single('file'), handleMulterError, uploadSubtaskAttachment);

/**
 * @route   DELETE /api/upload/task/:taskId/subtask/:subtaskId/attachment/:attachmentId
 * @desc    Delete attachment from a subtask
 * @access  Private
 */
router.delete('/task/:taskId/subtask/:subtaskId/attachment/:attachmentId', deleteSubtaskAttachment);

/**
 * @route   POST /api/upload/chat/:groupId
 * @desc    Upload attachment for chat message
 * @access  Private (chat group members only)
 */
router.post('/chat/:groupId', uploadChatMiddleware.single('file'), handleMulterError, uploadChatAttachment);

/**
 * @route   POST /api/upload/support
 * @desc    Upload attachment for support ticket or reply
 * @access  Private
 */
router.post('/support', uploadSupportMiddleware.single('file'), handleMulterError, uploadSupportAttachment);

/**
 * @route   POST /api/upload/note/:noteId
 * @desc    Upload attachment to a note
 * @access  Private (note owner or shared-with-edit-permission users)
 */
router.post('/note/:noteId', uploadNoteMiddleware.single('file'), handleMulterError, uploadNoteAttachment);

/**
 * @route   GET /api/upload/note/:noteId/attachments
 * @desc    Get all attachments for a note
 * @access  Private (note owner or shared-with users)
 */
router.get('/note/:noteId/attachments', getNoteAttachments);

/**
 * @route   DELETE /api/upload/note/:noteId/attachment/:attachmentId
 * @desc    Delete attachment from a note
 * @access  Private (note owner or shared-with-edit-permission users)
 */
router.delete('/note/:noteId/attachment/:attachmentId', deleteNoteAttachment);

export default router;
