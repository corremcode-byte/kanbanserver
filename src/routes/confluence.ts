import express, { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { authenticate, requireConfluencePermission } from '../middleware/auth';
import { uploadConfluenceImage } from '../middleware/upload';
import { uploadLimiter } from '../middleware/rateLimiter';
import * as confluenceController from '../controllers/confluenceController';
import { CONFLUENCE_MAX_IMAGE_SIZE_LABEL } from '../config/confluence';

const router = express.Router();

// Every Confluence route requires an authenticated user holding confluence.view.
// Finer rules — draft visibility, page restrictions, owner-may-edit-own, who may
// publish/delete a given page — are applied per document in the controller (see
// utils/confluenceAccess.ts). Route-level gates below cover the actions that are
// purely "may this user do X at all".
router.use(authenticate);
router.use(requireConfluencePermission('view'));

const canCreate = requireConfluencePermission('create');
const canComment = requireConfluencePermission('comment');

/** Multer error handler scoped to this router only. */
const handleConfluenceImageError = (err: any, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ success: false, message: `Image must be smaller than ${CONFLUENCE_MAX_IMAGE_SIZE_LABEL}` });
      return;
    }
    res.status(400).json({ success: false, message: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ success: false, message: err.message || 'Image upload failed' });
    return;
  }
  next();
};

// ── Literal paths first (so a literal segment is never captured as an :id) ──

/**
 * @route   GET /api/confluence/pages/tree
 * @desc    Every page the caller can see (no bodies), for the hierarchy sidebar
 */
router.get('/pages/tree', confluenceController.getTree);

/**
 * @route   GET /api/confluence/pages/search?q=&labels=
 * @desc    Search page titles, body text and labels
 */
router.get('/pages/search', confluenceController.searchPages);

/**
 * @route   GET /api/confluence/pages?scope=all|mine|recent|favorites|templates&labels=
 */
router.get('/pages', confluenceController.listPages);

/**
 * @route   POST /api/confluence/pages
 * @desc    Create a page (draft by default) or a template
 * @access  confluence.create (publishing on create additionally needs confluence.publish)
 */
router.post('/pages', canCreate, confluenceController.createPage);

/** @route GET /api/confluence/labels — labels in use, with counts */
router.get('/labels', confluenceController.listLabels);

/** @route GET /api/confluence/users — users who can use Confluence (restriction picker) */
router.get('/users', confluenceController.listConfluenceUsers);

/**
 * @route   GET /api/confluence/mentionable-users?q=&pageId=&parentId=
 * @desc    Server-side @mention search, limited to users who can open the page
 * @access  edit/comment on the page (pageId), or create (new page)
 */
router.get('/mentionable-users', confluenceController.searchMentionableUsers);

/**
 * @route   POST /api/confluence/images
 * @desc    Upload one image for insertion into a page
 * @access  confluence.create or confluence.edit
 *
 * Reuses the existing uploadLimiter unchanged. The permission check runs BEFORE
 * multer so a forbidden upload never writes to disk.
 */
router.post(
  '/images',
  uploadLimiter,
  confluenceController.requireConfluenceAuthor,
  uploadConfluenceImage.single('image'),
  handleConfluenceImageError,
  confluenceController.uploadImage
);

// ── Comments by id ─────────────────────────────────────────────────────────

/** @route PATCH /api/confluence/comments/:commentId — edit own comment */
router.patch('/comments/:commentId', confluenceController.updateComment);

/** @route DELETE /api/confluence/comments/:commentId — own comment, or confluence.delete */
router.delete('/comments/:commentId', confluenceController.deleteComment);

// ── Per-page paths ─────────────────────────────────────────────────────────

router.get('/pages/:id', confluenceController.getPage);
router.put('/pages/:id/draft', confluenceController.saveDraft);
router.delete('/pages/:id/draft', confluenceController.discardDraft);
router.post('/pages/:id/publish', confluenceController.publishPage);

// ── Review workflow ─────────────────────────────────────────────────────────
// Draft → In Review → Approve & Publish | Request Changes (→ Draft) | Withdraw.
// No route-level gate beyond authenticate + view: each handler checks the
// caller's rights ON THIS PAGE (submit/withdraw: edit; approve/request changes:
// edit + publish) and the page's current state, so a guessed or replayed request
// can't skip a step.
router.post('/pages/:id/review/submit', confluenceController.submitForReview);
router.post('/pages/:id/review/withdraw', confluenceController.withdrawReview);
router.post('/pages/:id/review/approve', confluenceController.approveReview);
router.post('/pages/:id/review/request-changes', confluenceController.requestChanges);

// ── Version history ─────────────────────────────────────────────────────────
// Versions are addressed by page + version number only, and every handler applies
// the page's current access rules first (404 for a page the caller can't see).
// Restore needs edit on the page; with publish it goes live as a new version,
// without publish it lands in the draft — decided per page in the controller.

/** @route GET /api/confluence/pages/:id/versions — history metadata (no content) */
router.get('/pages/:id/versions', confluenceController.listVersions);

/** @route GET /api/confluence/pages/:id/versions/:version — one version, read-only */
router.get('/pages/:id/versions/:version', confluenceController.getVersion);

/** @route POST /api/confluence/pages/:id/versions/:version/restore */
router.post('/pages/:id/versions/:version/restore', confluenceController.restoreVersion);
router.patch('/pages/:id/labels', confluenceController.updateLabels);
router.patch('/pages/:id/move', confluenceController.movePage);
router.patch('/pages/:id/restrictions', confluenceController.updateRestrictions);
router.post('/pages/:id/favorite', confluenceController.toggleFavorite);
router.get('/pages/:id/comments', confluenceController.listComments);

/** @route GET /api/confluence/pages/:id/activity?before=&limit= — page activity (metadata only) */
router.get('/pages/:id/activity', confluenceController.listActivity);
router.post('/pages/:id/comments', canComment, confluenceController.addComment);
router.delete('/pages/:id', confluenceController.deletePage);

export default router;
