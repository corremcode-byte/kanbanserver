import express, { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { authenticate, requireSharedFilesPermission } from '../middleware/auth';
import { uploadSharedFile } from '../middleware/upload';
import { uploadLimiter } from '../middleware/rateLimiter';
import * as sharedFilesController from '../controllers/sharedFilesController';
import { SHARED_FILES_MAX_FILE_SIZE_LABEL } from '../config/sharedFiles';

const router = express.Router();

// Every Shared Files route requires an authenticated user and then ONE
// authorization layer: the module permission (permissions.modules.sharedFiles,
// per action, administered in User Management).
//
// There is deliberately NO ownership layer. Shared Files is one global repository:
// a user who holds `view` sees every item, whoever uploaded it, and a user who
// holds `edit`/`delete` may rename/move/delete anyone's upload. `uploadedBy` is
// recorded for display and is never a filter. Contrast routes/personalFiles.ts,
// where the controller additionally scopes every query to the caller.
router.use(authenticate);

const canView = requireSharedFilesPermission('view');
const canCreate = requireSharedFilesPermission('create');
const canEdit = requireSharedFilesPermission('edit');
const canDelete = requireSharedFilesPermission('delete');

/**
 * Multer error handler scoped to this router only.
 */
const handleSharedFileUploadError = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        message: `File size must be less than ${SHARED_FILES_MAX_FILE_SIZE_LABEL}`
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
 * @route   GET /api/shared-files/tree
 * @desc    Folder-only hierarchy (for the Move dialog)
 * @access  Private (sharedFiles.view)
 */
router.get('/tree', canView, sharedFilesController.getTree);

/**
 * @route   GET /api/shared-files/search?q=
 * @desc    Search the whole shared repository by name
 * @access  Private (sharedFiles.view)
 */
router.get('/search', canView, sharedFilesController.searchItems);

/**
 * @route   GET /api/shared-files/usage
 * @desc    GLOBAL storage usage against the repository quota
 * @access  Private (sharedFiles.view)
 */
router.get('/usage', canView, sharedFilesController.getUsage);

/**
 * @route   GET /api/shared-files/recycle-bin
 * @desc    The one global recycle bin
 * @access  Private (sharedFiles.view)
 */
router.get('/recycle-bin', canView, sharedFilesController.listRecycleBin);

/**
 * @route   POST /api/shared-files/folders
 * @desc    Create a folder
 * @access  Private (sharedFiles.create)
 */
router.post('/folders', canCreate, sharedFilesController.createFolder);

/**
 * @route   POST /api/shared-files/upload
 * @desc    Upload one file into a folder
 * @access  Private (sharedFiles.create)
 *
 * Reuses the EXISTING uploadLimiter (the same limiter the other upload routes
 * use, applied here without altering its configuration).
 */
router.post(
  '/upload',
  uploadLimiter,
  // The permission gate runs BEFORE multer so a forbidden upload never writes
  // bytes to disk that would then have to be cleaned up.
  canCreate,
  uploadSharedFile.single('file'),
  handleSharedFileUploadError,
  sharedFilesController.uploadFile
);

/**
 * @route   POST /api/shared-files/bulk
 * @desc    Batch move/copy/delete/restore/permanentDelete for multi-selection
 * @access  Private (per-operation: move=edit, copy=create, others=delete)
 */
// No single gate fits /bulk: the operation arrives in the body. The controller
// resolves it and applies the matching permission itself - see bulkOperation.
router.post('/bulk', sharedFilesController.bulkOperation);

/**
 * @route   GET /api/shared-files?parentId=
 * @desc    List children of a folder (parentId omitted/null = root)
 * @access  Private (sharedFiles.view)
 */
router.get('/', canView, sharedFilesController.listItems);

// ── Per-item paths ───────────────────────────────────────────────────────────

/**
 * @route   GET /api/shared-files/:id/breadcrumb
 * @access  Private (sharedFiles.view)
 */
router.get('/:id/breadcrumb', canView, sharedFilesController.getBreadcrumb);

/**
 * @route   GET /api/shared-files/:id/download
 * @desc    Authenticated download/preview stream (the ONLY way file bytes are served)
 * @access  Private (sharedFiles.view)
 */
router.get('/:id/download', canView, sharedFilesController.downloadFile);

/**
 * @route   PATCH /api/shared-files/:id/rename
 * @access  Private (sharedFiles.edit)
 */
router.patch('/:id/rename', canEdit, sharedFilesController.renameItem);

/**
 * @route   PATCH /api/shared-files/:id/move
 * @access  Private (sharedFiles.edit)
 */
router.patch('/:id/move', canEdit, sharedFilesController.moveItem);

/**
 * @route   POST /api/shared-files/:id/copy
 * @access  Private (sharedFiles.create)
 */
router.post('/:id/copy', canCreate, sharedFilesController.copyItem);

/**
 * @route   POST /api/shared-files/:id/restore
 * @access  Private (sharedFiles.delete)
 */
router.post('/:id/restore', canDelete, sharedFilesController.restoreItem);

/**
 * @route   DELETE /api/shared-files/:id/permanent
 * @access  Private (sharedFiles.delete)
 */
router.delete('/:id/permanent', canDelete, sharedFilesController.permanentDeleteItem);

/**
 * @route   DELETE /api/shared-files/:id
 * @desc    Soft delete (global recycle bin), recursive for folders
 * @access  Private (sharedFiles.delete)
 */
router.delete('/:id', canDelete, sharedFilesController.deleteItem);

export default router;
