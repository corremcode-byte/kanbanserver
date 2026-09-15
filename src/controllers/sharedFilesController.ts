import { Request, Response } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { SharedFile, User } from '../models';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  createdResponse,
  internalServerErrorResponse
} from '../utils/responses';
import { logger } from '../utils/logger';
import { encryptField, decryptSharedFileFields } from '../utils/fieldEncryption';
import {
  SHARED_FILES_DIR,
  SHARED_FILES_RELATIVE_PREFIX,
  SHARED_FILES_QUOTA_BYTES,
  SHARED_FILES_MAX_FILE_BYTES,
  SHARED_FILES_MAX_NAME_LENGTH,
  SHARED_FILES_MAX_DEPTH,
  SHARED_FILES_MAX_BULK_ITEMS,
  SHARED_FILES_MAX_COPY_ITEMS,
  SHARED_FILES_FORCE_DOWNLOAD_MIME_TYPES,
  SHARED_FILES_INLINE_SAFE_PREFIXES,
  SHARED_FILES_INLINE_SAFE_EXACT
} from '../config/sharedFiles';

/**
 * Shared Files controller — ONE GLOBAL repository.
 *
 * How this differs from personalFilesController, and why it is a separate file
 * rather than a parameterised copy:
 *
 * - There is NO `userId: req.user._id` on any query. Every SharedFile record is
 *   visible to, and operable by, every user who passes the module permission gate
 *   (requireSharedFilesPermission). Authorization is "may this user use Shared
 *   Files at all?" and nothing else. Adding an ownership filter here would silently
 *   turn the module back into a per-user drive — the exact bug this module must
 *   never have.
 * - `uploadedBy` is recorded on every created record (upload, folder, copy) and
 *   resolved to a display name for the UI. It is metadata. It is never used to
 *   decide what a caller can see or do.
 * - Quota, recycle bin and search are all GLOBAL: usage is the sum over the whole
 *   collection, the bin lists everyone's deletions, and search matches everyone's
 *   uploads.
 * - Because several users mutate the same tree concurrently, every mutation
 *   re-reads its target immediately before writing and uses a state-qualified
 *   filter (`isDeleted: false` etc.) so a record another user changed in between
 *   produces a clean 404/409 rather than a lost update.
 */

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
  };
}

/* ---------------------------------------------------------------------------
   Pure helpers - exported for direct unit testing.
   --------------------------------------------------------------------------- */

/**
 * Validates a user-supplied folder/file name. Rejects empty/whitespace-only, over
 * the length limit, control characters, path separators, any `..` sequence and the
 * reserved `.` name. The ONLY place a name is accepted from a client.
 */
export function validateSharedFileName(raw: unknown): NameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Name is required' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'Name cannot be empty' };
  if (value.length > SHARED_FILES_MAX_NAME_LENGTH) {
    return { ok: false, error: `Name is too long (max ${SHARED_FILES_MAX_NAME_LENGTH} characters)` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, error: 'Name contains invalid characters' };
  }
  if (value.includes('/') || value.includes('\\')) {
    return { ok: false, error: 'Name cannot contain / or \\' };
  }
  if (value.includes('..')) {
    return { ok: false, error: 'Name cannot contain ".."' };
  }
  if (value === '.') {
    return { ok: false, error: 'Name is reserved' };
  }
  return { ok: true, value };
}

/**
 * Resolves a stored RELATIVE storagePath to an absolute path, refusing anything
 * that escapes SHARED_FILES_DIR. Absolute inputs, drive letters, null bytes, `..`
 * traversal and anything resolving outside the shared-files directory return null.
 */
export function resolveSharedFilePath(storagePath: unknown): string | null {
  if (typeof storagePath !== 'string' || storagePath.length === 0) return null;
  const normalised = storagePath.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\x00]/.test(normalised)) return null;
  if (path.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised)) return null;
  const withoutPrefix = normalised.startsWith(`${SHARED_FILES_RELATIVE_PREFIX}/`)
    ? normalised.slice(SHARED_FILES_RELATIVE_PREFIX.length + 1)
    : normalised;
  if (withoutPrefix.length === 0) return null;
  const absolute = path.resolve(SHARED_FILES_DIR, withoutPrefix);
  const root = path.resolve(SHARED_FILES_DIR);
  if (absolute === root) return null;
  if (!absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/** True when a mime type must never be served inline (browser-active content). */
export function isForcedDownloadMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return SHARED_FILES_FORCE_DOWNLOAD_MIME_TYPES.includes(base);
}

/** True when a mime type is safe to render inline for preview. */
export function isInlinePreviewableMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (isForcedDownloadMime(base)) return false;
  if (SHARED_FILES_INLINE_SAFE_EXACT.includes(base)) return true;
  return SHARED_FILES_INLINE_SAFE_PREFIXES.some((p) => base.startsWith(p));
}

/** Strips a `Content-Disposition` filename of anything that could break out of
 *  the quoted string or inject a header. */
export function sanitizeDispositionFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/["\\/]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, SHARED_FILES_MAX_NAME_LENGTH) : 'download';
}

/* ---------------------------------------------------------------------------
   Internal helpers
   --------------------------------------------------------------------------- */

type AnyDoc = Record<string, any>;

/** The four Shared Files module permissions administered in User Management. */
export type SharedFilesAction = 'view' | 'create' | 'edit' | 'delete';

/* strictNullChecks is off in this project, so discriminated unions are narrowed
   with explicit type guards (see personalFilesController for the full note). */

type NameOk = { ok: true; value: string };
type NameError = { ok: false; error: string };
type NameResult = NameOk | NameError;

function isNameError(result: NameResult): result is NameError {
  return result.ok === false;
}

type FolderOk = { folder: AnyDoc | null };
type FolderError = { error: string; status: number };
type FolderResult = FolderOk | FolderError;

function isFolderError(result: FolderResult): result is FolderError {
  return (result as FolderError).error !== undefined;
}

type OpFailure = { ok: false; status: number; message: string };

function isOpFailure(result: { ok: boolean }): result is OpFailure {
  return result.ok === false;
}

function requireUser(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.user || !req.user._id) {
    errorResponse(res, 'Authentication required', 401);
    return null;
  }
  return req.user._id;
}

/** Which module permission each bulk operation requires. Mirrors the route-level
 *  gates exactly: move => edit, copy => create, delete/restore/permanentDelete =>
 *  delete. Restore shares the delete capability because it is the undo of a
 *  delete — the same convention Personal Files established. */
export const BULK_OPERATION_PERMISSION: Record<string, SharedFilesAction> = {
  move: 'edit',
  copy: 'create',
  delete: 'delete',
  restore: 'delete',
  permanentDelete: 'delete'
};

/**
 * Reads one Shared Files module permission for the current request.
 *
 * Deliberately the same semantics as requireSharedFilesPermission in
 * middleware/auth.ts (superadmin passes; ONLY an explicit `true` grants; a missing
 * module or flag denies) so the route gates and this in-controller check can
 * never disagree.
 */
async function hasSharedFilesPermission(
  req: AuthenticatedRequest,
  action: SharedFilesAction
): Promise<boolean> {
  if (!req.user) return false;
  if ((req.user as { role?: string }).role === 'superadmin') return true;
  try {
    const user = await User.findById(req.user._id).select('permissions.modules.sharedFiles');
    const modulePerms = (user as AnyDoc | null)?.permissions?.modules?.sharedFiles;
    return !!modulePerms && modulePerms[action] === true;
  } catch (error) {
    logger.error('Error checking Shared Files permission:', error);
    // Fail closed on an infrastructure error.
    return false;
  }
}

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

/** Normalises an incoming parentId. The root is `null`; clients may send null,
 *  "null", "root", an empty string, or omit it. */
function parseParentId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '' || raw === 'null' || raw === 'root') {
    return { ok: true, value: null };
  }
  if (isValidId(raw)) return { ok: true, value: raw as string };
  return { ok: false };
}

/** Public API shape. `storagePath` is deliberately NEVER included. `uploadedBy`
 *  is the resolved `{ _id, displayName }` (see attachUploaders) — the only user
 *  identity exposed, and one the app already shows everywhere. */
function toApiItem(doc: AnyDoc) {
  const uploader = doc.uploadedBy;
  const uploadedBy =
    uploader && typeof uploader === 'object' && 'displayName' in uploader
      ? { _id: String(uploader._id), displayName: String(uploader.displayName || 'Unknown user') }
      : uploader
        ? { _id: String(uploader), displayName: 'Unknown user' }
        : null;
  return {
    _id: String(doc._id),
    type: doc.type,
    name: doc.name,
    parentId: doc.parentId ? String(doc.parentId) : null,
    path: Array.isArray(doc.path) ? doc.path.map((p: any) => String(p)) : [],
    mimeType: doc.mimeType,
    size: doc.size,
    uploadedBy,
    isDeleted: !!doc.isDeleted,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

/** Decrypts a lean document in place and returns the client-safe shape. */
function decryptToApi(doc: AnyDoc) {
  decryptSharedFileFields(doc as any);
  return toApiItem(doc);
}

/**
 * Resolves `uploadedBy` ids to `{ _id, displayName }` in ONE query for a whole
 * listing, so "Uploaded by" never costs a request per row. Mutates the docs in
 * place. A user that no longer exists resolves to "Unknown user" rather than
 * failing the listing.
 */
async function attachUploaders(docs: AnyDoc[]): Promise<AnyDoc[]> {
  const ids = new Set<string>();
  for (const d of docs) {
    const raw = d.uploadedBy;
    if (raw && typeof raw !== 'object') ids.add(String(raw));
    else if (raw && typeof raw === 'object' && !('displayName' in raw)) ids.add(String(raw));
  }
  if (ids.size === 0) return docs;
  let users: AnyDoc[] = [];
  try {
    users = ((await User.find({ _id: { $in: [...ids] } })
      .select('_id displayName')
      .lean()) || []) as AnyDoc[];
  } catch (error) {
    logger.warn('Shared Files: uploader lookup failed; names will show as unknown', error);
  }
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const d of docs) {
    const raw = d.uploadedBy;
    if (!raw || (typeof raw === 'object' && 'displayName' in raw)) continue;
    const user = byId.get(String(raw));
    d.uploadedBy = { _id: String(raw), displayName: user?.displayName || 'Unknown user' };
  }
  return docs;
}

/** Decrypts + resolves uploaders + maps a whole listing. */
async function toApiList(docs: AnyDoc[]) {
  await attachUploaders(docs);
  return docs.map(decryptToApi);
}

/**
 * Loads a live folder, or resolves to `null` for the root. Global: any live
 * folder is a valid location for any permitted user.
 */
async function loadFolder(parentId: string | null): Promise<FolderResult> {
  if (parentId === null) return { folder: null };
  const folder = await SharedFile.findOne({
    _id: parentId,
    type: 'folder',
    isDeleted: false
  }).lean();
  if (!folder) return { error: 'Destination folder not found', status: 404 };
  return { folder: folder as AnyDoc };
}

/**
 * Rejects a name that already exists among the live children of `parentId`.
 * Folders and files share one namespace; comparison is case-insensitive. Names
 * are encrypted per-document so siblings are fetched and decrypted in Node,
 * bounded by the `{ parentId, isDeleted }` index.
 */
async function findNameConflict(
  parentId: string | null,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const siblings = await SharedFile.find({
    parentId: parentId === null ? null : parentId,
    isDeleted: false
  })
    .select('_id name')
    .lean();
  const target = name.trim().toLowerCase();
  return ((siblings || []) as AnyDoc[]).some((s) => {
    if (excludeId && String(s._id) === String(excludeId)) return false;
    decryptSharedFileFields(s as any);
    return String(s.name || '').trim().toLowerCase() === target;
  });
}

/** Picks a non-conflicting name by appending " (n)". */
async function nextAvailableName(parentId: string | null, desired: string): Promise<string> {
  if (!(await findNameConflict(parentId, desired))) return desired;
  const ext = path.extname(desired);
  const base = ext ? desired.slice(0, -ext.length) : desired;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base} (${i})${ext}`.slice(0, SHARED_FILES_MAX_NAME_LENGTH);
    if (!(await findNameConflict(parentId, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`.slice(0, SHARED_FILES_MAX_NAME_LENGTH);
}

/** Every descendant of a folder, resolved via the materialised ancestor array. */
async function loadSubtree(folderId: string, includeDeleted = false): Promise<AnyDoc[]> {
  const query: AnyDoc = { path: folderId };
  if (!includeDeleted) query.isDeleted = false;
  const rows = await SharedFile.find(query).lean();
  return (rows || []) as AnyDoc[];
}

/**
 * GLOBAL storage usage — the sum over every file in the repository, whoever
 * uploaded it. Trashed files still occupy disk, so they still count toward the
 * quota and are reported separately so the UI can prompt emptying the bin.
 */
async function computeUsage() {
  const rows = (await SharedFile.aggregate([
    { $match: { type: 'file' } },
    {
      $group: {
        _id: '$isDeleted',
        bytes: { $sum: { $ifNull: ['$size', 0] } },
        count: { $sum: 1 }
      }
    }
  ])) as Array<{ _id: boolean; bytes: number; count: number }>;

  let usedBytes = 0;
  let trashedBytes = 0;
  let fileCount = 0;
  for (const r of rows || []) {
    usedBytes += r.bytes || 0;
    if (r._id === true) trashedBytes += r.bytes || 0;
    else fileCount += r.count || 0;
  }
  const remainingBytes = Math.max(0, SHARED_FILES_QUOTA_BYTES - usedBytes);
  return {
    usedBytes,
    trashedBytes,
    quotaBytes: SHARED_FILES_QUOTA_BYTES,
    remainingBytes,
    fileCount,
    maxFileBytes: SHARED_FILES_MAX_FILE_BYTES
  };
}

/** Best-effort physical delete. A missing file is NOT an error. */
async function safeUnlink(relativeStoragePath: string | undefined): Promise<void> {
  const absolute = resolveSharedFilePath(relativeStoragePath);
  if (!absolute) {
    logger.warn('Shared Files: refusing to unlink unsafe storagePath');
    return;
  }
  try {
    await fsp.unlink(absolute);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return;
    logger.error('Shared Files: failed to delete physical file', err);
  }
}

/* ---------------------------------------------------------------------------
   Handlers
   --------------------------------------------------------------------------- */

/**
 * GET /api/shared-files?parentId=
 * Lists the live children of one folder (parentId omitted/null = root). Global —
 * every permitted user gets the same listing.
 */
export const listItems = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const parsed = parseParentId(req.query.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const parent = await loadFolder(parsed.value);
    if (isFolderError(parent)) {
      notFoundResponse(res, 'Folder not found');
      return;
    }

    const rows = await SharedFile.find({
      parentId: parsed.value,
      isDeleted: false
    }).lean();

    successResponse(res, 'Items retrieved successfully', {
      parentId: parsed.value,
      items: await toApiList((rows || []) as AnyDoc[])
    });
  } catch (error) {
    logger.error('Error in listItems:', error);
    internalServerErrorResponse(res, 'Failed to retrieve files');
  }
};

/**
 * GET /api/shared-files/tree
 * Folder-only hierarchy for the Move dialog.
 */
export const getTree = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const rows = await SharedFile.find({ type: 'folder', isDeleted: false }).lean();

    successResponse(res, 'Folder tree retrieved successfully', {
      folders: ((rows || []) as AnyDoc[]).map(decryptToApi)
    });
  } catch (error) {
    logger.error('Error in getTree:', error);
    internalServerErrorResponse(res, 'Failed to retrieve folder tree');
  }
};

/**
 * GET /api/shared-files/:id/breadcrumb
 */
export const getBreadcrumb = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    const item = (await SharedFile.findOne({ _id: id }).lean()) as AnyDoc | null;
    if (!item) {
      notFoundResponse(res, 'Item not found');
      return;
    }

    const ancestorIds: string[] = (item.path || []).map((p: any) => String(p));
    const ancestorRows = ancestorIds.length
      ? await SharedFile.find({ _id: { $in: ancestorIds } }).lean()
      : [];
    const ancestors = (ancestorRows || []) as AnyDoc[];
    const byId = new Map(ancestors.map((a) => [String(a._id), a]));
    const ordered = ancestorIds
      .map((aid: string) => byId.get(aid))
      .filter((a): a is AnyDoc => !!a)
      .map(decryptToApi);

    successResponse(res, 'Breadcrumb retrieved successfully', {
      breadcrumb: [...ordered, decryptToApi(item)]
    });
  } catch (error) {
    logger.error('Error in getBreadcrumb:', error);
    internalServerErrorResponse(res, 'Failed to retrieve breadcrumb');
  }
};

/**
 * POST /api/shared-files/folders   { name, parentId }
 */
export const createFolder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const actorId = requireUser(req, res);
    if (!actorId) return;

    const nameCheck = validateSharedFileName(req.body?.name);
    if (isNameError(nameCheck)) {
      errorResponse(res, nameCheck.error, 400);
      return;
    }

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const parent = await loadFolder(parsed.value);
    if (isFolderError(parent)) {
      notFoundResponse(res, 'Parent folder not found');
      return;
    }

    const parentFolder = (parent as FolderOk).folder;
    const parentPath: string[] = parentFolder
      ? [...(parentFolder.path || []).map((p: any) => String(p)), String(parentFolder._id)]
      : [];
    if (parentPath.length >= SHARED_FILES_MAX_DEPTH) {
      errorResponse(res, `Maximum folder depth of ${SHARED_FILES_MAX_DEPTH} reached`, 400);
      return;
    }

    if (await findNameConflict(parsed.value, nameCheck.value)) {
      errorResponse(res, 'An item with this name already exists in this folder', 409);
      return;
    }

    const folder = new SharedFile({
      type: 'folder',
      name: nameCheck.value,
      parentId: parsed.value,
      path: parentPath,
      uploadedBy: actorId,
      isDeleted: false
    });

    folder.name = encryptField(nameCheck.value, folder._id.toString()) as string;
    await folder.save();

    const saved = (typeof folder.toObject === 'function' ? folder.toObject() : folder) as AnyDoc;
    saved.uploadedBy = { _id: actorId, displayName: req.user?.displayName || 'Unknown user' };
    successResponse(res, 'Folder created successfully', { item: decryptToApi(saved) }, 201);
  } catch (error) {
    logger.error('Error in createFolder:', error);
    internalServerErrorResponse(res, 'Failed to create folder');
  }
};

/**
 * POST /api/shared-files/upload   (multipart: file, parentId)
 * The physical file is already on disk (multer), so every failure path cleans it up.
 */
export const uploadFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const uploaded = (req as AnyDoc).file as
    | { filename: string; originalname: string; mimetype: string; size: number; path: string }
    | undefined;

  const discardUpload = async () => {
    if (!uploaded?.filename) return;
    await safeUnlink(`${SHARED_FILES_RELATIVE_PREFIX}/${uploaded.filename}`);
  };

  try {
    const actorId = requireUser(req, res);
    if (!actorId) {
      await discardUpload();
      return;
    }

    if (!uploaded) {
      errorResponse(res, 'No file was uploaded', 400);
      return;
    }

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      await discardUpload();
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const parent = await loadFolder(parsed.value);
    if (isFolderError(parent)) {
      await discardUpload();
      notFoundResponse(res, 'Parent folder not found');
      return;
    }

    const nameCheck = validateSharedFileName(
      typeof req.body?.name === 'string' && req.body.name.trim()
        ? req.body.name
        : path.basename(uploaded.originalname || 'file')
    );
    if (isNameError(nameCheck)) {
      await discardUpload();
      errorResponse(res, nameCheck.error, 400);
      return;
    }

    // Trust the on-disk size, not any client-declared value.
    let actualSize = uploaded.size;
    try {
      actualSize = (await fsp.stat(uploaded.path)).size;
    } catch {
      // Fall back to multer's reported size if stat fails.
    }

    if (actualSize > SHARED_FILES_MAX_FILE_BYTES) {
      await discardUpload();
      errorResponse(res, `File exceeds the maximum size of ${SHARED_FILES_MAX_FILE_BYTES} bytes`, 400);
      return;
    }

    // GLOBAL quota: the whole repository's usage, not this user's.
    const usage = await computeUsage();
    if (usage.usedBytes + actualSize > usage.quotaBytes) {
      await discardUpload();
      errorResponse(
        res,
        'Shared storage quota exceeded. Free up space or empty the recycle bin to upload more files.',
        413
      );
      return;
    }

    const finalName = await nextAvailableName(parsed.value, nameCheck.value);

    const parentFolder = (parent as FolderOk).folder;
    const parentPath: string[] = parentFolder
      ? [...(parentFolder.path || []).map((p: any) => String(p)), String(parentFolder._id)]
      : [];

    const relativeStoragePath = `${SHARED_FILES_RELATIVE_PREFIX}/${uploaded.filename}`;

    const doc = new SharedFile({
      type: 'file',
      name: finalName,
      parentId: parsed.value,
      path: parentPath,
      mimeType: (uploaded.mimetype || 'application/octet-stream').split(';')[0].trim(),
      size: actualSize,
      uploadedBy: actorId,
      isDeleted: false
    });

    const docId = doc._id.toString();
    doc.name = encryptField(finalName, docId) as string;
    doc.storagePath = encryptField(relativeStoragePath, docId);
    doc.originalName = encryptField(path.basename(uploaded.originalname || finalName), docId);

    try {
      await doc.save();
    } catch (dbError) {
      // DB write failed AFTER the physical upload - remove the orphan.
      await discardUpload();
      logger.error('Shared Files: DB record failed after upload, orphan removed', dbError);
      internalServerErrorResponse(res, 'Failed to save the uploaded file');
      return;
    }

    const saved = (typeof doc.toObject === 'function' ? doc.toObject() : doc) as AnyDoc;
    saved.uploadedBy = { _id: actorId, displayName: req.user?.displayName || 'Unknown user' };
    createdResponse(res, 'File uploaded successfully', { item: decryptToApi(saved) });
  } catch (error) {
    await discardUpload();
    logger.error('Error in uploadFile:', error);
    internalServerErrorResponse(res, 'Failed to upload file');
  }
};

/**
 * PATCH /api/shared-files/:id/rename   { name }
 * Database-only. The write is qualified on `isDeleted: false` so a concurrent
 * delete by another user makes this a clean 404 instead of resurrecting the name.
 */
export const renameItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    const nameCheck = validateSharedFileName(req.body?.name);
    if (isNameError(nameCheck)) {
      errorResponse(res, nameCheck.error, 400);
      return;
    }

    const item = (await SharedFile.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
    if (!item) {
      notFoundResponse(res, 'Item not found');
      return;
    }

    const parentId = item.parentId ? String(item.parentId) : null;
    if (await findNameConflict(parentId, nameCheck.value, String(item._id))) {
      errorResponse(res, 'An item with this name already exists in this folder', 409);
      return;
    }

    const result: AnyDoc = await SharedFile.updateOne(
      { _id: id, isDeleted: false },
      { $set: { name: encryptField(nameCheck.value, String(item._id)) as string } }
    );
    if (!result || (result.matchedCount ?? result.n ?? result.modifiedCount ?? 0) === 0) {
      // Deleted (or otherwise changed) by another user between read and write.
      errorResponse(res, 'This item was changed by another user. Refresh and try again.', 409);
      return;
    }

    const updated = (await SharedFile.findOne({ _id: id }).lean()) as AnyDoc | null;
    successResponse(res, 'Renamed successfully', {
      item: (await toApiList([updated || item]))[0]
    });
  } catch (error) {
    logger.error('Error in renameItem:', error);
    internalServerErrorResponse(res, 'Failed to rename item');
  }
};

/**
 * Re-parents one item and repairs the whole subtree's ancestor arrays.
 * Returns false when the item is no longer live (concurrent delete).
 */
async function applyMove(
  item: AnyDoc,
  newParentId: string | null,
  newParentPath: string[]
): Promise<boolean> {
  const itemId = String(item._id);

  const result: AnyDoc = await SharedFile.updateOne(
    { _id: itemId, isDeleted: false },
    { $set: { parentId: newParentId, path: newParentPath } }
  );
  if (!result || (result.matchedCount ?? result.n ?? result.modifiedCount ?? 0) === 0) return false;

  if (item.type !== 'folder') return true;

  const descendants = await loadSubtree(itemId, true);
  if (descendants.length === 0) return true;

  const ops = descendants.map((d) => {
    const oldPath = (d.path || []).map((p: any) => String(p));
    const idx = oldPath.indexOf(itemId);
    const tail = idx === -1 ? [itemId] : oldPath.slice(idx);
    return {
      updateOne: {
        filter: { _id: d._id },
        update: { $set: { path: [...newParentPath, ...tail] } }
      }
    };
  });
  await SharedFile.bulkWrite(ops);
  return true;
}

/** Shared move validation + execution, used by /move and /bulk. */
async function moveOne(
  id: string,
  destParentId: string | null
): Promise<{ ok: true; item: AnyDoc } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  // Re-read the source right before acting; never trust client state.
  const item = (await SharedFile.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  // Destination must be a LIVE folder - validated independently of the source.
  const dest = await loadFolder(destParentId);
  if (isFolderError(dest)) return { ok: false, status: dest.status, message: dest.error };

  const itemId = String(item._id);
  const destFolder = (dest as FolderOk).folder;
  const destPath: string[] = destFolder
    ? [...(destFolder.path || []).map((p: any) => String(p)), String(destFolder._id)]
    : [];

  // Cycle prevention (server-side, authoritative).
  if (item.type === 'folder') {
    if (destFolder && String(destFolder._id) === itemId) {
      return { ok: false, status: 400, message: 'A folder cannot be moved into itself' };
    }
    if (destPath.includes(itemId)) {
      return { ok: false, status: 400, message: 'A folder cannot be moved into one of its own subfolders' };
    }
  }

  const currentParentId = item.parentId ? String(item.parentId) : null;
  if (currentParentId === destParentId) {
    return { ok: true, item };
  }

  if (item.type === 'folder') {
    const descendants = await loadSubtree(itemId, true);
    const currentDepth = (item.path || []).length;
    const relativeDepth = descendants.reduce(
      (max, d) => Math.max(max, (d.path || []).length - currentDepth),
      0
    );
    if (destPath.length + 1 + relativeDepth > SHARED_FILES_MAX_DEPTH) {
      return {
        ok: false,
        status: 400,
        message: `Moving here would exceed the maximum folder depth of ${SHARED_FILES_MAX_DEPTH}`
      };
    }
  } else if (destPath.length >= SHARED_FILES_MAX_DEPTH) {
    return { ok: false, status: 400, message: `Maximum folder depth of ${SHARED_FILES_MAX_DEPTH} reached` };
  }

  const decrypted = decryptSharedFileFields({ ...item } as any);
  if (await findNameConflict(destParentId, String(decrypted.name || ''), itemId)) {
    return {
      ok: false,
      status: 409,
      message: 'An item with this name already exists in the destination folder'
    };
  }

  const moved = await applyMove(item, destParentId, destPath);
  if (!moved) {
    return { ok: false, status: 409, message: 'This item was changed by another user. Refresh and try again.' };
  }

  const updated = (await SharedFile.findOne({ _id: itemId }).lean()) as AnyDoc | null;
  return { ok: true, item: updated || item };
}

/**
 * PATCH /api/shared-files/:id/move   { parentId }
 */
export const moveItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const result = await moveOne(req.params.id, parsed.value);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    successResponse(res, 'Moved successfully', { item: (await toApiList([{ ...result.item }]))[0] });
  } catch (error) {
    logger.error('Error in moveItem:', error);
    internalServerErrorResponse(res, 'Failed to move item');
  }
};

/**
 * Copies one item (recursively for folders). Every created record and physical
 * file is tracked so a partial failure rolls back completely.
 *
 * The copies are attributed to the COPIER (`uploadedBy = actorId`): a copy creates
 * brand-new records and new bytes on disk, and the person who performed it is the
 * one who put them there. The copies are, of course, still shared like everything
 * else in the repository.
 */
async function copyOne(
  actorId: string,
  id: string,
  destParentId: string | null
): Promise<{ ok: true; item: AnyDoc } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const source = (await SharedFile.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
  if (!source) return { ok: false, status: 404, message: 'Item not found' };

  const dest = await loadFolder(destParentId);
  if (isFolderError(dest)) return { ok: false, status: dest.status, message: dest.error };

  const sourceId = String(source._id);
  const destFolder = (dest as FolderOk).folder;
  const destPath: string[] = destFolder
    ? [...(destFolder.path || []).map((p: any) => String(p)), String(destFolder._id)]
    : [];

  if (source.type === 'folder' && (destPath.includes(sourceId) || String(destFolder?._id) === sourceId)) {
    return { ok: false, status: 400, message: 'A folder cannot be copied into itself' };
  }

  const subtree = source.type === 'folder' ? await loadSubtree(sourceId) : [];
  if (subtree.length + 1 > SHARED_FILES_MAX_COPY_ITEMS) {
    return { ok: false, status: 400, message: `A copy may not exceed ${SHARED_FILES_MAX_COPY_ITEMS} items` };
  }

  if (destPath.length + 1 > SHARED_FILES_MAX_DEPTH) {
    return { ok: false, status: 400, message: `Maximum folder depth of ${SHARED_FILES_MAX_DEPTH} reached` };
  }

  // GLOBAL quota, checked for the WHOLE copy before a single byte is written.
  const bytesNeeded =
    (source.type === 'file' ? source.size || 0 : 0) +
    subtree.reduce((sum, d) => sum + (d.type === 'file' ? d.size || 0 : 0), 0);
  const usage = await computeUsage();
  if (usage.usedBytes + bytesNeeded > usage.quotaBytes) {
    return {
      ok: false,
      status: 413,
      message: 'Shared storage quota exceeded - not enough space to complete this copy'
    };
  }

  const createdIds: string[] = [];
  const createdFiles: string[] = [];

  const duplicate = async (
    src: AnyDoc,
    newParentId: string | null,
    newParentPath: string[],
    overrideName?: string
  ): Promise<AnyDoc> => {
    const decryptedSrc = decryptSharedFileFields({ ...src } as any);
    const doc = new SharedFile({
      type: src.type,
      name: 'pending',
      parentId: newParentId,
      path: newParentPath,
      mimeType: src.mimeType,
      size: src.size,
      uploadedBy: actorId,
      isDeleted: false
    });
    const newId = doc._id.toString();
    const logicalName = overrideName ?? String(decryptedSrc.name || 'Untitled');
    doc.name = encryptField(logicalName, newId) as string;

    if (src.type === 'file') {
      // A copied file gets its OWN new physical file so two records never share
      // bytes on disk.
      const sourceAbsolute = resolveSharedFilePath(decryptedSrc.storagePath);
      const ext = path.extname(String(decryptedSrc.storagePath || ''));
      const safeExt = /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext.toLowerCase() : '';
      const newFilename = `${Date.now()}-${randomUUID()}${safeExt}`;
      const newAbsolute = path.join(SHARED_FILES_DIR, newFilename);
      if (sourceAbsolute) {
        await fsp.copyFile(sourceAbsolute, newAbsolute);
        createdFiles.push(`${SHARED_FILES_RELATIVE_PREFIX}/${newFilename}`);
      } else {
        logger.warn('Shared Files: copy source had an unresolvable storagePath');
      }
      doc.storagePath = encryptField(`${SHARED_FILES_RELATIVE_PREFIX}/${newFilename}`, newId);
      doc.originalName = encryptField(String(decryptedSrc.originalName || logicalName), newId);
    }

    await doc.save();
    createdIds.push(newId);
    return (typeof doc.toObject === 'function' ? doc.toObject() : doc) as AnyDoc;
  };

  try {
    const decryptedSource = decryptSharedFileFields({ ...source } as any);
    const copyName = await nextAvailableName(destParentId, String(decryptedSource.name || 'Untitled'));
    const root = await duplicate(source, destParentId, destPath, copyName);

    if (source.type === 'folder' && subtree.length > 0) {
      const idMap = new Map<string, { id: string; path: string[] }>();
      idMap.set(sourceId, { id: String(root._id), path: [...destPath, String(root._id)] });

      const sorted = [...subtree].sort((a, b) => (a.path || []).length - (b.path || []).length);
      for (const node of sorted) {
        const oldParentId = node.parentId ? String(node.parentId) : null;
        const mapped = oldParentId ? idMap.get(oldParentId) : undefined;
        if (!mapped) {
          logger.warn('Shared Files: skipping subtree node with uncopied parent');
          continue;
        }
        const created = await duplicate(node, mapped.id, mapped.path);
        if (node.type === 'folder') {
          idMap.set(String(node._id), {
            id: String(created._id),
            path: [...mapped.path, String(created._id)]
          });
        }
      }
    }

    return { ok: true, item: root };
  } catch (err) {
    logger.error('Shared Files: copy failed, rolling back', err);
    try {
      if (createdIds.length) await SharedFile.deleteMany({ _id: { $in: createdIds } });
    } catch (cleanupErr) {
      logger.error('Shared Files: rollback of copied records failed', cleanupErr);
    }
    for (const f of createdFiles) await safeUnlink(f);
    return { ok: false, status: 500, message: 'Failed to copy - no partial copy was kept' };
  }
}

/**
 * POST /api/shared-files/:id/copy   { parentId }
 */
export const copyItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const actorId = requireUser(req, res);
    if (!actorId) return;

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const result = await copyOne(actorId, req.params.id, parsed.value);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    const saved = { ...result.item, uploadedBy: { _id: actorId, displayName: req.user?.displayName || 'Unknown user' } };
    createdResponse(res, 'Copied successfully', { item: decryptToApi(saved) });
  } catch (error) {
    logger.error('Error in copyItem:', error);
    internalServerErrorResponse(res, 'Failed to copy item');
  }
};

/** Soft-deletes one item and, for a folder, its entire subtree. */
async function softDeleteOne(
  actorId: string,
  id: string
): Promise<{ ok: true; deletedCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await SharedFile.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  const now = new Date();
  const result: AnyDoc = await SharedFile.updateOne(
    { _id: id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: now, deletedBy: actorId } }
  );
  if (!result || (result.matchedCount ?? result.n ?? result.modifiedCount ?? 0) === 0) {
    // Someone else deleted it first - the outcome they wanted already holds.
    return { ok: false, status: 404, message: 'Item not found' };
  }

  let deletedCount = 1;
  if (item.type === 'folder') {
    const many: AnyDoc = await SharedFile.updateMany(
      { path: String(item._id), isDeleted: false },
      { $set: { isDeleted: true, deletedAt: now, deletedBy: actorId } }
    );
    deletedCount += many?.modifiedCount || 0;
  }
  return { ok: true, deletedCount };
}

/**
 * DELETE /api/shared-files/:id
 * Soft delete into the ONE GLOBAL recycle bin. Nothing is removed from disk here.
 */
export const deleteItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const actorId = requireUser(req, res);
    if (!actorId) return;

    const result = await softDeleteOne(actorId, req.params.id);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    successResponse(res, 'Moved to recycle bin', { deletedCount: result.deletedCount });
  } catch (error) {
    logger.error('Error in deleteItem:', error);
    internalServerErrorResponse(res, 'Failed to delete item');
  }
};

/**
 * GET /api/shared-files/recycle-bin
 * The ONE GLOBAL bin: everyone's deletions, root-of-deleted-subtree only.
 */
export const listRecycleBin = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const rows = await SharedFile.find({ isDeleted: true }).sort({ deletedAt: -1 }).lean();
    const deleted = (rows || []) as AnyDoc[];

    const deletedIds = new Set(deleted.map((d) => String(d._id)));
    const roots = deleted.filter((d) => !d.parentId || !deletedIds.has(String(d.parentId)));

    successResponse(res, 'Recycle bin retrieved successfully', {
      items: await toApiList(roots)
    });
  } catch (error) {
    logger.error('Error in listRecycleBin:', error);
    internalServerErrorResponse(res, 'Failed to retrieve recycle bin');
  }
};

/** Restores one item (and its subtree). */
async function restoreOne(id: string): Promise<{ ok: true; restoredCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await SharedFile.findOne({ _id: id, isDeleted: true }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found in the recycle bin' };

  // If the original parent is gone or still trashed, restore to the root.
  let targetParentId: string | null = item.parentId ? String(item.parentId) : null;
  let targetPath: string[] = (item.path || []).map((p: any) => String(p));
  if (targetParentId) {
    const parent = (await SharedFile.findOne({
      _id: targetParentId,
      type: 'folder',
      isDeleted: false
    }).lean()) as AnyDoc | null;
    if (!parent) {
      targetParentId = null;
      targetPath = [];
    }
  }

  const decrypted = decryptSharedFileFields({ ...item } as any);
  let restoreName = String(decrypted.name || 'Restored');
  if (await findNameConflict(targetParentId, restoreName, String(item._id))) {
    restoreName = await nextAvailableName(targetParentId, restoreName);
  }

  const result: AnyDoc = await SharedFile.updateOne(
    { _id: id, isDeleted: true },
    {
      $set: {
        isDeleted: false,
        parentId: targetParentId,
        path: targetPath,
        name: encryptField(restoreName, String(item._id)) as string
      },
      $unset: { deletedAt: 1, deletedBy: 1 }
    }
  );
  if (!result || (result.matchedCount ?? result.n ?? result.modifiedCount ?? 0) === 0) {
    // Already restored or permanently deleted by someone else.
    return { ok: false, status: 404, message: 'Item not found in the recycle bin' };
  }

  let restoredCount = 1;
  if (item.type === 'folder') {
    const descendants = await loadSubtree(String(item._id), true);
    if (descendants.length) {
      const itemId = String(item._id);
      const ops = descendants.map((d) => {
        const oldPath = (d.path || []).map((p: any) => String(p));
        const idx = oldPath.indexOf(itemId);
        const tail = idx === -1 ? [itemId] : oldPath.slice(idx);
        return {
          updateOne: {
            filter: { _id: d._id },
            update: {
              $set: { isDeleted: false, path: [...targetPath, ...tail] },
              $unset: { deletedAt: 1, deletedBy: 1 }
            }
          }
        };
      });
      await SharedFile.bulkWrite(ops);
      restoredCount += descendants.length;
    }
  }
  return { ok: true, restoredCount };
}

/**
 * POST /api/shared-files/:id/restore
 */
export const restoreItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const result = await restoreOne(req.params.id);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    successResponse(res, 'Restored successfully', { restoredCount: result.restoredCount });
  } catch (error) {
    logger.error('Error in restoreItem:', error);
    internalServerErrorResponse(res, 'Failed to restore item');
  }
};

/** Permanently removes one item, its subtree, and their physical files. */
async function permanentDeleteOne(id: string): Promise<{ ok: true; deletedCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await SharedFile.findOne({ _id: id }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  const subtree = item.type === 'folder' ? await loadSubtree(String(item._id), true) : [];
  const all = [item, ...subtree];

  // The database is authoritative: records go first, then a best-effort physical
  // sweep. A file already missing from disk never fails the request.
  const ids = all.map((d) => d._id);
  await SharedFile.deleteMany({ _id: { $in: ids } });

  for (const doc of all) {
    if (doc.type !== 'file') continue;
    const decrypted = decryptSharedFileFields({ ...doc } as any);
    await safeUnlink(decrypted.storagePath);
  }

  return { ok: true, deletedCount: all.length };
}

/**
 * DELETE /api/shared-files/:id/permanent
 */
export const permanentDeleteItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const result = await permanentDeleteOne(req.params.id);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    successResponse(res, 'Deleted permanently', { deletedCount: result.deletedCount });
  } catch (error) {
    logger.error('Error in permanentDeleteItem:', error);
    internalServerErrorResponse(res, 'Failed to permanently delete item');
  }
};

/**
 * POST /api/shared-files/bulk   { operation, ids, parentId? }
 *
 * Every item goes through the SAME helper as its single-item route. The operation
 * arrives in the body, so the matching module permission is resolved and enforced
 * here - a bulk call is never a way around a revoked permission.
 */
export const bulkOperation = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const actorId = requireUser(req, res);
    if (!actorId) return;

    const { operation, ids } = req.body || {};
    const allowed = ['move', 'copy', 'delete', 'restore', 'permanentDelete'];
    if (!allowed.includes(operation)) {
      errorResponse(res, `operation must be one of: ${allowed.join(', ')}`, 400);
      return;
    }

    if (!(await hasSharedFilesPermission(req, BULK_OPERATION_PERMISSION[operation]))) {
      errorResponse(res, 'You do not have permission to perform this action on Shared Files', 403);
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      errorResponse(res, 'ids must be a non-empty array', 400);
      return;
    }
    if (ids.length > SHARED_FILES_MAX_BULK_ITEMS) {
      errorResponse(res, `A bulk operation may not exceed ${SHARED_FILES_MAX_BULK_ITEMS} items`, 400);
      return;
    }

    let destParentId: string | null = null;
    if (operation === 'move' || operation === 'copy') {
      const parsed = parseParentId(req.body?.parentId);
      if (!parsed.ok) {
        errorResponse(res, 'Invalid parentId', 400);
        return;
      }
      destParentId = parsed.value;
    }

    const succeeded: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];

    for (const rawId of ids) {
      const id = String(rawId);
      let result:
        | { ok: true; item?: AnyDoc; deletedCount?: number; restoredCount?: number }
        | OpFailure;
      switch (operation) {
        case 'move':
          result = await moveOne(id, destParentId);
          break;
        case 'copy':
          result = await copyOne(actorId, id, destParentId);
          break;
        case 'delete':
          result = await softDeleteOne(actorId, id);
          break;
        case 'restore':
          result = await restoreOne(id);
          break;
        default:
          result = await permanentDeleteOne(id);
          break;
      }
      if (isOpFailure(result)) failed.push({ id, message: result.message });
      else succeeded.push(id);
    }

    successResponse(res, `Bulk ${operation} completed`, {
      operation,
      succeeded,
      failed,
      successCount: succeeded.length,
      failureCount: failed.length
    });
  } catch (error) {
    logger.error('Error in bulkOperation:', error);
    internalServerErrorResponse(res, 'Failed to complete bulk operation');
  }
};

/**
 * GET /api/shared-files/search?q=
 *
 * GLOBAL: matches every live item in the repository, whoever uploaded it. Names
 * are encrypted per-document so they are decrypted and matched in Node, bounded
 * by the `{ isDeleted }` index.
 */
export const searchItems = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length === 0) {
      successResponse(res, 'Search completed', { query: '', items: [] });
      return;
    }

    const rows = await SharedFile.find({ isDeleted: false }).lean();
    const needle = q.toLowerCase();
    const matched = ((rows || []) as AnyDoc[])
      .map((r) => {
        decryptSharedFileFields(r as any);
        return r;
      })
      .filter((r) => String(r.name || '').toLowerCase().includes(needle))
      .slice(0, 500);

    await attachUploaders(matched);
    successResponse(res, 'Search completed', { query: q, items: matched.map(toApiItem) });
  } catch (error) {
    logger.error('Error in searchItems:', error);
    internalServerErrorResponse(res, 'Failed to search files');
  }
};

/**
 * GET /api/shared-files/usage — the GLOBAL repository's usage.
 */
export const getUsage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const usage = await computeUsage();
    const folderCount = await SharedFile.countDocuments({ type: 'folder', isDeleted: false });

    successResponse(res, 'Usage retrieved successfully', { ...usage, folderCount });
  } catch (error) {
    logger.error('Error in getUsage:', error);
    internalServerErrorResponse(res, 'Failed to retrieve storage usage');
  }
};

/**
 * GET /api/shared-files/:id/download?disposition=inline|attachment
 *
 * The ONLY way a shared file's bytes leave the server. Shared files are never
 * reachable through the public /uploads static mount: the physical filename is a
 * UUID, the stored path is encrypted and never sent to a client, and server.ts
 * blocks /uploads/shared-files outright.
 */
export const downloadFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    // Global: any live file is downloadable by any user holding view.
    const file = (await SharedFile.findOne({
      _id: id,
      type: 'file',
      isDeleted: false
    }).lean()) as AnyDoc | null;
    if (!file) {
      notFoundResponse(res, 'File not found');
      return;
    }

    decryptSharedFileFields(file as any);

    const absolute = resolveSharedFilePath(file.storagePath);
    if (!absolute) {
      logger.error('Shared Files: stored path failed safe resolution');
      notFoundResponse(res, 'File not found');
      return;
    }

    if (!fs.existsSync(absolute)) {
      // Record survived but bytes are gone (e.g. permanently deleted by another
      // user mid-request). Honest 404, never a crash.
      logger.warn('Shared Files: physical file missing on download');
      notFoundResponse(res, 'The stored file is no longer available on the server');
      return;
    }

    const mimeType = String(file.mimeType || 'application/octet-stream');
    const wantsInline = req.query.disposition === 'inline';
    const inline = wantsInline && !isForcedDownloadMime(mimeType);
    const safeName = sanitizeDispositionFilename(String(file.name || 'download'));

    res.setHeader('Content-Type', inline ? mimeType : 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof file.size === 'number') res.setHeader('Content-Length', String(file.size));

    const stream = fs.createReadStream(absolute);
    stream.on('error', (err) => {
      logger.error('Shared Files: stream error during download', err);
      if (!res.headersSent) {
        internalServerErrorResponse(res, 'Failed to read the file');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (error) {
    logger.error('Error in downloadFile:', error);
    if (!res.headersSent) internalServerErrorResponse(res, 'Failed to download file');
  }
};
