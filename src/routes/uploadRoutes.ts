import express, { Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import upload from '../middleware/upload';
import {
  uploadTaskAttachment,
  deleteTaskAttachment,
  getTaskAttachments
} from '../controllers/uploadController';
import { MulterError } from 'multer';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Multer error handler
const handleMulterError = (err: any, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        message: 'File size must be less than 50MB'
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
router.post('/task/:taskId', upload.single('file'), handleMulterError, uploadTaskAttachment);

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

export default router;
