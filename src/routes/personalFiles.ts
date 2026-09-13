import express, { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { authenticate, requirePersonalFilesPermission } from '../middleware/auth';
import { uploadPersonalFile } from '../middleware/upload';
import { uploadLimiter } from '../middleware/rateLimiter';
import * as personalFilesController from '../controllers/personalFilesController';
import { PERSONAL_FILES_MAX_FILE_SIZE_LABEL } from '../config/personalFiles';

const router = express.Router();

// Every Personal Files route requires an authenticated user, and then TWO
// independent authorization layers:
//   1. module permission - may this user use the Personal Files feature at all?
//      Granted per action (view/create/edit/delete) from
//      permissions.modules.personalFiles, administered in User Management.
//   2. ownership - which documents may they touch? Enforced in the controller by
//      scoping every single query to `userId: req.user._id`.
// Neither replaces the other. No role, including admin and superadmin, can reach
// another user's personal files through either layer.
router.use(authenticate);

// Per-action module permission gates. These answer "may this user use the feature?"
// and are layered ON TOP OF - never instead of - the ownership scoping every
// controller query performs (`userId: req.user._id`). See
// requirePersonalFilesPermission for why both checks are required.
const canView = requirePersonalFilesPermission('view');
const canCreate = requirePersonalFilesPermission('create');
const canEdit = requirePersonalFilesPermission('edit');
const canDelete = requirePersonalFilesPermission('delete');

/**
 * Multer error handler scoped to this router only - the existing upload routes
 * keep their own handler untouched.
 */
const handlePersonalFileUploadError = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        message: `File size must be less than ${PERSONAL_FILES_MAX_FILE_SIZE_LABEL}`
      });
      return;
    }
    res.status(400).json({ success: false, message: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ success: false, message: err.message || 'File upload failed' });
    return;
  }
  next();
};

// ── Literal paths first ──────────────────────────────────────────────────────
// Declared ahead of the /:id routes so a literal segment can never be captured
// as an id.

/**
 * @route   GET /api/personal-files/tree
 * @desc    Folder-only hierarchy (for the Move dialog)
 * @access  Private (own files only)
 */
router.get('/tree', canView, personalFilesController.getTree);

/**
 * @route   GET /api/personal-files/search?q=
 * @desc    Search own file/folder names
 * @access  Private (own files only)
 */
router.get('/search', canView, personalFilesController.searchItems);

/**
 * @route   GET /api/personal-files/usage
 * @desc    Storage usage against the per-user quota
 * @access  Private (own files only)
 */
router.get('/usage', canView, personalFilesController.getUsage);

/**
 * @route   GET /api/personal-files/recycle-bin
 * @desc    List soft-deleted items
 * @access  Private (own files only)
 */
router.get('/recycle-bin', canView, personalFilesController.listRecycleBin);

/**
 * @route   POST /api/personal-files/folders
 * @desc    Create a folder
 * @access  Private (own files only)
 */
router.post('/folders', canCreate, personalFilesController.createFolder);

/**
 * @route   POST /api/personal-files/upload
 * @desc    Upload one file into a folder
 * @access  Private (own files only)
 *
 * Reuses the EXISTING uploadLimiter (10 uploads/minute/IP) - the same limiter the
 * other upload routes use, applied here without altering its configuration.
 */
router.post(
  '/upload',
  uploadLimiter,
  // The permission gate runs BEFORE multer so a forbidden upload never writes
  // bytes to disk that would then have to be cleaned up.
  canCreate,
  uploadPersonalFile.single('file'),
  handlePersonalFileUploadError,
  personalFilesController.uploadFile
);

/**
 * @route   POST /api/personal-files/bulk
 * @desc    Batch move/copy/delete/restore/permanentDelete for multi-selection
 * @access  Private (own files only)
 */
// No single gate fits /bulk: one request can carry move (edit), copy (create),
// delete/restore/permanentDelete (delete). The controller resolves the operation
// and applies the matching permission itself - see bulkOperation.
router.post('/bulk', personalFilesController.bulkOperation);

/**
 * @route   GET /api/personal-files?parentId=
 * @desc    List children of a folder (parentId omitted/null = root)
 * @access  Private (own files only)
 */
router.get('/', canView, personalFilesController.listItems);

// ── Per-item paths ───────────────────────────────────────────────────────────

/**
 * @route   GET /api/personal-files/:id/breadcrumb
 * @desc    Ancestor chain from root to the item
 * @access  Private (own files only)
 */
router.get('/:id/breadcrumb', canView, personalFilesController.getBreadcrumb);

/**
 * @route   GET /api/personal-files/:id/download
 * @desc    Authenticated download/preview stream (the ONLY way file bytes are served)
 * @access  Private (own files only)
 */
router.get('/:id/download', canView, personalFilesController.downloadFile);

/**
 * @route   PATCH /api/personal-files/:id/rename
 * @desc    Rename a file or folder (database-only)
 * @access  Private (own files only)
 */
router.patch('/:id/rename', canEdit, personalFilesController.renameItem);

/**
 * @route   PATCH /api/personal-files/:id/move
 * @desc    Move a file or folder (database-only; cycles rejected server-side)
 * @access  Private (own files only)
 */
router.patch('/:id/move', canEdit, personalFilesController.moveItem);

/**
 * @route   POST /api/personal-files/:id/copy
 * @desc    Copy a file, or recursively copy a folder
 * @access  Private (own files only)
 */
router.post('/:id/copy', canCreate, personalFilesController.copyItem);

/**
 * @route   POST /api/personal-files/:id/restore
 * @desc    Restore an item from the recycle bin
 * @access  Private (own files only)
 */
router.post('/:id/restore', canDelete, personalFilesController.restoreItem);

/**
 * @route   DELETE /api/personal-files/:id/permanent
 * @desc    Permanently delete an item, its subtree and their physical files
 * @access  Private (own files only)
 */
router.delete('/:id/permanent', canDelete, personalFilesController.permanentDeleteItem);

/**
 * @route   DELETE /api/personal-files/:id
 * @desc    Soft delete (move to recycle bin), recursive for folders
 * @access  Private (own files only)
 */
router.delete('/:id', canDelete, personalFilesController.deleteItem);

export default router;
