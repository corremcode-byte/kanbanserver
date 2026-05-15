import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as commentsController from '../controllers/commentsController';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/comments/task/:taskId
 * @desc    Get all comments for a task
 * @access  Private (project members)
 */
router.get('/counts', commentsController.getCommentCounts);
router.get('/task/:taskId', commentsController.getComments);

/**
 * @route   POST /api/comments/task/:taskId
 * @desc    Add a comment to a task
 * @access  Private (project members)
 */
router.post('/task/:taskId', commentsController.addComment);

/**
 * @route   PUT /api/comments/task/:taskId/:commentId
 * @desc    Update a comment
 * @access  Private (comment creator only)
 */
router.put('/task/:taskId/:commentId', commentsController.updateComment);

/**
 * @route   DELETE /api/comments/task/:taskId/:commentId
 * @desc    Delete a comment
 * @access  Private (owner/admin/manager/creator)
 */
router.delete('/task/:taskId/:commentId', commentsController.deleteComment);

export default router;
