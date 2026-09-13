import { Request, Response } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { PersonalFile, User } from '../models';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  createdResponse,
  internalServerErrorResponse
} from '../utils/responses';
import { logger } from '../utils/logger';
import { encryptField, decryptPersonalFileFields } from '../utils/fieldEncryption';
import {
  PERSONAL_FILES_DIR,
  PERSONAL_FILES_RELATIVE_PREFIX,
  PERSONAL_FILES_QUOTA_BYTES,
  PERSONAL_FILES_MAX_FILE_BYTES,
  PERSONAL_FILES_MAX_NAME_LENGTH,
  PERSONAL_FILES_MAX_DEPTH,
  PERSONAL_FILES_MAX_BULK_ITEMS,
  PERSONAL_FILES_MAX_COPY_ITEMS,
  PERSONAL_FILES_FORCE_DOWNLOAD_MIME_TYPES,
  PERSONAL_FILES_INLINE_SAFE_PREFIXES,
  PERSONAL_FILES_INLINE_SAFE_EXACT
} from '../config/personalFiles';

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
 * Validates a user-supplied folder/file name.
 *
 * Rejects: empty/whitespace-only, over the length limit, control characters,
 * path separators (`/` and backslash), any `..` sequence, and the reserved `.`
 * name. Returns the trimmed value on success. This is the ONLY place a name is
 * accepted from a client - every create/rename/upload path runs through it.
 */
export function validatePersonalFileName(raw: unknown): NameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Name is required' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'Name cannot be empty' };
  if (value.length > PERSONAL_FILES_MAX_NAME_LENGTH) {
    return { ok: false, error: `Name is too long (max ${PERSONAL_FILES_MAX_NAME_LENGTH} characters)` };
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
 * that escapes PERSONAL_FILES_DIR.
 *
 * Defence in depth: storagePath is generated server-side and encrypted at rest, so
 * it should never be hostile - but the download endpoint treats it as untrusted
 * anyway. Absolute inputs, `..` traversal and anything resolving outside the
 * personal-files directory all return null.
 */
export function resolvePersonalFilePath(storagePath: unknown): string | null {
  if (typeof storagePath !== 'string' || storagePath.length === 0) return null;
  // Normalise separators so a Windows-style stored path resolves the same way.
  const normalised = storagePath.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\x00]/.test(normalised)) return null;
  if (path.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised)) return null;
  // Strip the relative prefix the database stores ("personal-files/<file>").
  const withoutPrefix = normalised.startsWith(`${PERSONAL_FILES_RELATIVE_PREFIX}/`)
    ? normalised.slice(PERSONAL_FILES_RELATIVE_PREFIX.length + 1)
    : normalised;
  if (withoutPrefix.length === 0) return null;
  const absolute = path.resolve(PERSONAL_FILES_DIR, withoutPrefix);
  const root = path.resolve(PERSONAL_FILES_DIR);
  // Must be strictly INSIDE the storage root - never the root itself, never a
  // sibling directory that merely shares a name prefix.
  if (absolute === root) return null;
  if (!absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/** True when a mime type must never be served inline (browser-active content). */
export function isForcedDownloadMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return PERSONAL_FILES_FORCE_DOWNLOAD_MIME_TYPES.includes(base);
}

/** True when a mime type is safe to render inline for preview. */
export function isInlinePreviewableMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (isForcedDownloadMime(base)) return false;
  if (PERSONAL_FILES_INLINE_SAFE_EXACT.includes(base)) return true;
  return PERSONAL_FILES_INLINE_SAFE_PREFIXES.some((p) => base.startsWith(p));
}

/**
 * Strips a `Content-Disposition` filename of anything that could break out of the
 * quoted string or inject a header (quotes, backslashes, CR/LF, control chars).
 */
export function sanitizeDispositionFilename(name: string): string {
  const cleaned = name
    // Control characters (CR/LF included) are REMOVED, not substituted, so a name
    // made only of them collapses to empty and falls back to "download".
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Quote/backslash/slash would break out of the quoted filename token.
    .replace(/["\\/]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, PERSONAL_FILES_MAX_NAME_LENGTH) : 'download';
}

/* ---------------------------------------------------------------------------
   Internal helpers
   --------------------------------------------------------------------------- */

type AnyDoc = Record<string, any>;

/** The four Personal Files module permissions administered in User Management. */
export type PersonalFilesAction = 'view' | 'create' | 'edit' | 'delete';

/* This project compiles with `strictNullChecks: false` (see tsconfig.json), under
   which TypeScript does NOT narrow a discriminated union by a boolean literal
   discriminant or by the `in` operator. These explicit user-defined type guards
   narrow correctly regardless of that setting - that is why the code below tests
   results with `isOpFailure(...)` rather than `if (!result.ok)`. */

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
 *  delete (restore being the undo of a delete, it shares that capability). */
export const BULK_OPERATION_PERMISSION: Record<string, PersonalFilesAction> = {
  move: 'edit',
  copy: 'create',
  delete: 'delete',
  restore: 'delete',
  permanentDelete: 'delete'
};

/**
 * Reads one Personal Files module permission for the current request.
 *
 * Deliberately the same semantics as requirePersonalFilesPermission in
 * middleware/auth.ts (superadmin passes; an absent module or absent flag is granted
 * for backward compatibility; only an explicit `false` denies) so the route gates
 * and this in-controller check can never disagree.
 */
async function hasPersonalFilesPermission(
  req: AuthenticatedRequest,
  action: PersonalFilesAction
): Promise<boolean> {
  if (!req.user) return false;
  if ((req.user as { role?: string }).role === 'superadmin') return true;
  try {
    const user = await User.findById(req.user._id).select('permissions.modules.personalFiles');
    const modulePerms = (user as AnyDoc | null)?.permissions?.modules?.personalFiles;
    return modulePerms === undefined || modulePerms[action] !== false;
  } catch (error) {
    logger.error('Error checking Personal Files permission:', error);
    // Fail closed on an infrastructure error - a lookup failure must not become an
    // implicit grant.
    return false;
  }
}

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

/**
 * Normalises an incoming parentId. The root folder is `null`; clients may send
 * null, the string "null", an empty string, or omit it entirely.
 */
function parseParentId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '' || raw === 'null' || raw === 'root') {
    return { ok: true, value: null };
  }
  if (isValidId(raw)) return { ok: true, value: raw as string };
  return { ok: false };
}

/** Public API shape. `storagePath` is deliberately NEVER included - the physical
 *  location is server-only; clients address files by id through /download. */
function toApiItem(doc: AnyDoc) {
  return {
    _id: String(doc._id),
    type: doc.type,
    name: doc.name,
    parentId: doc.parentId ? String(doc.parentId) : null,
    path: Array.isArray(doc.path) ? doc.path.map((p: any) => String(p)) : [],
    mimeType: doc.mimeType,
    size: doc.size,
    isDeleted: !!doc.isDeleted,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

/** Decrypts a lean document in place and returns the client-safe shape. */
function decryptToApi(doc: AnyDoc) {
  decryptPersonalFileFields(doc as any);
  return toApiItem(doc);
}

/**
 * Loads a folder the user owns, or resolves to `null` for the root.
 * Returns an error descriptor when the id is malformed, missing, deleted, or not a
 * folder - a destination the caller does not own is indistinguishable from a
 * nonexistent one.
 */
async function loadOwnedFolder(userId: string, parentId: string | null): Promise<FolderResult> {
  if (parentId === null) return { folder: null };
  const folder = await PersonalFile.findOne({
    _id: parentId,
    userId,
    type: 'folder',
    isDeleted: false
  }).lean();
  if (!folder) return { error: 'Destination folder not found', status: 404 };
  return { folder: folder as AnyDoc };
}

/**
 * Rejects a name that already exists among the live children of `parentId`.
 *
 * Folders and files share one namespace inside a folder, matching file-explorer
 * behaviour. Because `name` is encrypted per-document with a random nonce it
 * cannot be queried directly, so siblings are fetched and decrypted in Node -
 * bounded by the `{ userId, parentId }` index and by one folder's child count.
 * Comparison is case-insensitive, like Windows.
 */
async function findNameConflict(
  userId: string,
  parentId: string | null,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const siblings = await PersonalFile.find({
    userId,
    parentId: parentId === null ? null : parentId,
    isDeleted: false
  })
    .select('_id name')
    .lean();
  const target = name.trim().toLowerCase();
  return ((siblings || []) as AnyDoc[]).some((s) => {
    if (excludeId && String(s._id) === String(excludeId)) return false;
    decryptPersonalFileFields(s as any);
    return String(s.name || '').trim().toLowerCase() === target;
  });
}

/**
 * Picks a non-conflicting name by appending " (n)" - used by copy and upload, so
 * landing in a folder that already holds that name never hard-fails.
 */
async function nextAvailableName(
  userId: string,
  parentId: string | null,
  desired: string
): Promise<string> {
  if (!(await findNameConflict(userId, parentId, desired))) return desired;
  const ext = path.extname(desired);
  const base = ext ? desired.slice(0, -ext.length) : desired;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base} (${i})${ext}`.slice(0, PERSONAL_FILES_MAX_NAME_LENGTH);
    if (!(await findNameConflict(userId, parentId, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`.slice(0, PERSONAL_FILES_MAX_NAME_LENGTH);
}

/** Every descendant of a folder, resolved via the materialised ancestor array. */
async function loadSubtree(userId: string, folderId: string, includeDeleted = false): Promise<AnyDoc[]> {
  const query: AnyDoc = { userId, path: folderId };
  if (!includeDeleted) query.isDeleted = false;
  const rows = await PersonalFile.find(query).lean();
  return (rows || []) as AnyDoc[];
}

/** Current storage usage. Trashed files still occupy disk, so they still count
 *  toward the quota - reported separately so the UI can prompt emptying the bin. */
async function computeUsage(userId: string) {
  const rows = (await PersonalFile.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), type: 'file' } },
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
  const remainingBytes = Math.max(0, PERSONAL_FILES_QUOTA_BYTES - usedBytes);
  return {
    usedBytes,
    trashedBytes,
    quotaBytes: PERSONAL_FILES_QUOTA_BYTES,
    remainingBytes,
    fileCount,
    maxFileBytes: PERSONAL_FILES_MAX_FILE_BYTES
  };
}

/** Best-effort physical delete. A missing file is NOT an error - the database is
 *  authoritative, and a request must never fail because the disk already lost a
 *  file. Any other failure is logged for operator follow-up. */
async function safeUnlink(relativeStoragePath: string | undefined): Promise<void> {
  const absolute = resolvePersonalFilePath(relativeStoragePath);
  if (!absolute) {
    logger.warn('Personal Files: refusing to unlink unsafe storagePath');
    return;
  }
  try {
    await fsp.unlink(absolute);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return; // already gone - nothing to do
    logger.error('Personal Files: failed to delete physical file', err);
  }
}

/* ---------------------------------------------------------------------------
   Handlers
   --------------------------------------------------------------------------- */

/**
 * GET /api/personal-files?parentId=
 * Lists the live children of one folder (parentId omitted/null = root).
 */
export const listItems = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = parseParentId(req.query.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    // Confirm the folder being listed belongs to the caller before returning
    // anything - otherwise an unowned id would simply list as "empty", which
    // leaks nothing but also silently succeeds.
    const parent = await loadOwnedFolder(userId, parsed.value);
    if (isFolderError(parent)) {
      notFoundResponse(res, 'Folder not found');
      return;
    }

    const rows = await PersonalFile.find({
      userId,
      parentId: parsed.value,
      isDeleted: false
    }).lean();

    successResponse(res, 'Items retrieved successfully', {
      parentId: parsed.value,
      items: ((rows || []) as AnyDoc[]).map(decryptToApi)
    });
  } catch (error) {
    logger.error('Error in listItems:', error);
    internalServerErrorResponse(res, 'Failed to retrieve files');
  }
};

/**
 * GET /api/personal-files/tree
 * Folder-only hierarchy for the Move dialog. Files are excluded deliberately -
 * the dialog only ever needs destinations.
 */
export const getTree = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const rows = await PersonalFile.find({
      userId,
      type: 'folder',
      isDeleted: false
    }).lean();

    successResponse(res, 'Folder tree retrieved successfully', {
      folders: ((rows || []) as AnyDoc[]).map(decryptToApi)
    });
  } catch (error) {
    logger.error('Error in getTree:', error);
    internalServerErrorResponse(res, 'Failed to retrieve folder tree');
  }
};

/**
 * GET /api/personal-files/:id/breadcrumb
 * Ancestors from root through the item itself.
 */
export const getBreadcrumb = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    const item = (await PersonalFile.findOne({ _id: id, userId }).lean()) as AnyDoc | null;
    if (!item) {
      notFoundResponse(res, 'Item not found');
      return;
    }

    // Ancestors are fetched in one query, then re-ordered to match `path`. The
    // query stays scoped by userId so even a tampered path array could never pull
    // in another user's documents.
    const ancestorIds: string[] = (item.path || []).map((p: any) => String(p));
    const ancestorRows = ancestorIds.length
      ? await PersonalFile.find({ _id: { $in: ancestorIds }, userId }).lean()
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
 * POST /api/personal-files/folders   { name, parentId }
 */
export const createFolder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const nameCheck = validatePersonalFileName(req.body?.name);
    if (isNameError(nameCheck)) {
      errorResponse(res, nameCheck.error, 400);
      return;
    }

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const parent = await loadOwnedFolder(userId, parsed.value);
    if (isFolderError(parent)) {
      notFoundResponse(res, 'Parent folder not found');
      return;
    }

    const parentFolder = (parent as FolderOk).folder;
    const parentPath: string[] = parentFolder
      ? [...(parentFolder.path || []).map((p: any) => String(p)), String(parentFolder._id)]
      : [];
    if (parentPath.length >= PERSONAL_FILES_MAX_DEPTH) {
      errorResponse(res, `Maximum folder depth of ${PERSONAL_FILES_MAX_DEPTH} reached`, 400);
      return;
    }

    if (await findNameConflict(userId, parsed.value, nameCheck.value)) {
      errorResponse(res, 'An item with this name already exists in this folder', 409);
      return;
    }

    const folder = new PersonalFile({
      userId,
      type: 'folder',
      name: nameCheck.value,
      parentId: parsed.value,
      path: parentPath,
      isDeleted: false
    });

    // Encrypt keyed by this document's own _id - the project-wide pattern
    // (encrypt before save, decrypt the same document before responding).
    folder.name = encryptField(nameCheck.value, folder._id.toString()) as string;
    await folder.save();

    const saved = (typeof folder.toObject === 'function' ? folder.toObject() : folder) as AnyDoc;
    successResponse(res, 'Folder created successfully', { item: decryptToApi(saved) }, 201);
  } catch (error) {
    logger.error('Error in createFolder:', error);
    internalServerErrorResponse(res, 'Failed to create folder');
  }
};

/**
 * POST /api/personal-files/upload   (multipart: file, parentId)
 *
 * The physical file is already on disk by the time this runs (multer), so every
 * failure path from here on must clean that orphan up.
 */
export const uploadFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const uploaded = (req as AnyDoc).file as
    | { filename: string; originalname: string; mimetype: string; size: number; path: string }
    | undefined;

  /** Removes the just-written physical file. Called on EVERY failure path so a
   *  rejected upload never leaves bytes behind. */
  const discardUpload = async () => {
    if (!uploaded?.filename) return;
    await safeUnlink(`${PERSONAL_FILES_RELATIVE_PREFIX}/${uploaded.filename}`);
  };

  try {
    const userId = requireUser(req, res);
    if (!userId) {
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

    const parent = await loadOwnedFolder(userId, parsed.value);
    if (isFolderError(parent)) {
      await discardUpload();
      notFoundResponse(res, 'Parent folder not found');
      return;
    }

    // The display name comes from the client's original filename, but it runs
    // through the same validator as a typed name - and it never influences the
    // physical filename, which multer generated from a UUID.
    const nameCheck = validatePersonalFileName(
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

    if (actualSize > PERSONAL_FILES_MAX_FILE_BYTES) {
      await discardUpload();
      errorResponse(res, `File exceeds the maximum size of ${PERSONAL_FILES_MAX_FILE_BYTES} bytes`, 400);
      return;
    }

    const usage = await computeUsage(userId);
    if (usage.usedBytes + actualSize > usage.quotaBytes) {
      await discardUpload();
      errorResponse(
        res,
        'Storage quota exceeded. Free up space or empty the recycle bin to upload more files.',
        413
      );
      return;
    }

    // On a duplicate name, auto-suffix rather than rejecting - the bytes are
    // already on disk, and Explorer behaves the same way.
    const finalName = await nextAvailableName(userId, parsed.value, nameCheck.value);

    const parentFolder = (parent as FolderOk).folder;
    const parentPath: string[] = parentFolder
      ? [...(parentFolder.path || []).map((p: any) => String(p)), String(parentFolder._id)]
      : [];

    const relativeStoragePath = `${PERSONAL_FILES_RELATIVE_PREFIX}/${uploaded.filename}`;

    const doc = new PersonalFile({
      userId,
      type: 'file',
      name: finalName,
      parentId: parsed.value,
      path: parentPath,
      mimeType: (uploaded.mimetype || 'application/octet-stream').split(';')[0].trim(),
      size: actualSize,
      isDeleted: false
    });

    const docId = doc._id.toString();
    doc.name = encryptField(finalName, docId) as string;
    doc.storagePath = encryptField(relativeStoragePath, docId);
    doc.originalName = encryptField(path.basename(uploaded.originalname || finalName), docId);

    try {
      await doc.save();
    } catch (dbError) {
      // Database write failed AFTER the physical upload - remove the orphan so
      // disk usage can never drift above what the database accounts for.
      await discardUpload();
      logger.error('Personal Files: DB record failed after upload, orphan removed', dbError);
      internalServerErrorResponse(res, 'Failed to save the uploaded file');
      return;
    }

    const saved = (typeof doc.toObject === 'function' ? doc.toObject() : doc) as AnyDoc;
    createdResponse(res, 'File uploaded successfully', { item: decryptToApi(saved) });
  } catch (error) {
    await discardUpload();
    logger.error('Error in uploadFile:', error);
    internalServerErrorResponse(res, 'Failed to upload file');
  }
};

/**
 * PATCH /api/personal-files/:id/rename   { name }
 * A pure database operation - the physical filename never changes.
 */
export const renameItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    const nameCheck = validatePersonalFileName(req.body?.name);
    if (isNameError(nameCheck)) {
      errorResponse(res, nameCheck.error, 400);
      return;
    }

    const item = await PersonalFile.findOne({ _id: id, userId, isDeleted: false });
    if (!item) {
      notFoundResponse(res, 'Item not found');
      return;
    }

    const parentId = item.parentId ? String(item.parentId) : null;
    if (await findNameConflict(userId, parentId, nameCheck.value, String(item._id))) {
      errorResponse(res, 'An item with this name already exists in this folder', 409);
      return;
    }

    item.name = encryptField(nameCheck.value, String(item._id)) as string;
    await item.save();

    const saved = (typeof item.toObject === 'function' ? item.toObject() : item) as AnyDoc;
    successResponse(res, 'Renamed successfully', { item: decryptToApi(saved) });
  } catch (error) {
    logger.error('Error in renameItem:', error);
    internalServerErrorResponse(res, 'Failed to rename item');
  }
};

/**
 * Re-parents one item and repairs the whole subtree's ancestor arrays.
 * Assumes ownership and cycle checks have already passed.
 */
async function applyMove(
  userId: string,
  item: AnyDoc,
  newParentId: string | null,
  newParentPath: string[]
): Promise<void> {
  const itemId = String(item._id);

  await PersonalFile.updateOne(
    { _id: itemId, userId },
    { $set: { parentId: newParentId, path: newParentPath } }
  );

  if (item.type !== 'folder') return;

  // Rewrite every descendant's ancestor array: keep the portion from this item
  // onward (unchanged by the move) and splice the new prefix in front.
  const descendants = await loadSubtree(userId, itemId, true);
  if (descendants.length === 0) return;

  const ops = descendants.map((d) => {
    const oldPath = (d.path || []).map((p: any) => String(p));
    const idx = oldPath.indexOf(itemId);
    const tail = idx === -1 ? [itemId] : oldPath.slice(idx);
    return {
      updateOne: {
        filter: { _id: d._id, userId },
        update: { $set: { path: [...newParentPath, ...tail] } }
      }
    };
  });
  await PersonalFile.bulkWrite(ops);
}

/**
 * Shared move validation + execution. Returns an error descriptor instead of
 * writing to the response so both /move and /bulk can use it.
 */
async function moveOne(
  userId: string,
  id: string,
  destParentId: string | null
): Promise<{ ok: true; item: AnyDoc } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  // Source must belong to the caller.
  const item = (await PersonalFile.findOne({ _id: id, userId, isDeleted: false }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  // Destination must ALSO belong to the caller - checked independently of the source.
  const dest = await loadOwnedFolder(userId, destParentId);
  if (isFolderError(dest)) return { ok: false, status: dest.status, message: dest.error };

  const itemId = String(item._id);
  const destFolder = (dest as FolderOk).folder;
  const destPath: string[] = destFolder
    ? [...(destFolder.path || []).map((p: any) => String(p)), String(destFolder._id)]
    : [];

  // -- Cycle prevention (server-side, authoritative) -------------------------
  // A folder may not be moved into itself, nor into any of its own descendants.
  // Both cases are caught by asking whether the destination IS the item or has
  // the item somewhere in its ancestor chain.
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
    return { ok: true, item }; // already there - a no-op, not an error
  }

  // Depth ceiling for the deepest node in the moved subtree.
  if (item.type === 'folder') {
    const descendants = await loadSubtree(userId, itemId, true);
    const currentDepth = (item.path || []).length;
    const relativeDepth = descendants.reduce(
      (max, d) => Math.max(max, (d.path || []).length - currentDepth),
      0
    );
    if (destPath.length + 1 + relativeDepth > PERSONAL_FILES_MAX_DEPTH) {
      return {
        ok: false,
        status: 400,
        message: `Moving here would exceed the maximum folder depth of ${PERSONAL_FILES_MAX_DEPTH}`
      };
    }
  } else if (destPath.length >= PERSONAL_FILES_MAX_DEPTH) {
    return { ok: false, status: 400, message: `Maximum folder depth of ${PERSONAL_FILES_MAX_DEPTH} reached` };
  }

  const decrypted = decryptPersonalFileFields({ ...item } as any);
  if (await findNameConflict(userId, destParentId, String(decrypted.name || ''), itemId)) {
    return {
      ok: false,
      status: 409,
      message: 'An item with this name already exists in the destination folder'
    };
  }

  await applyMove(userId, item, destParentId, destPath);

  const updated = (await PersonalFile.findOne({ _id: itemId, userId }).lean()) as AnyDoc | null;
  return { ok: true, item: updated || item };
}

/**
 * PATCH /api/personal-files/:id/move   { parentId }
 */
export const moveItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const result = await moveOne(userId, req.params.id, parsed.value);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    successResponse(res, 'Moved successfully', { item: decryptToApi({ ...result.item }) });
  } catch (error) {
    logger.error('Error in moveItem:', error);
    internalServerErrorResponse(res, 'Failed to move item');
  }
};

/**
 * Copies one item (recursively for folders).
 *
 * Every created document id and every written physical file is tracked so a
 * partial failure can be rolled back - a half-copied folder tree is worse than
 * no copy at all.
 */
async function copyOne(
  userId: string,
  id: string,
  destParentId: string | null
): Promise<{ ok: true; item: AnyDoc } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const source = (await PersonalFile.findOne({ _id: id, userId, isDeleted: false }).lean()) as AnyDoc | null;
  if (!source) return { ok: false, status: 404, message: 'Item not found' };

  const dest = await loadOwnedFolder(userId, destParentId);
  if (isFolderError(dest)) return { ok: false, status: dest.status, message: dest.error };

  const sourceId = String(source._id);
  const destFolder = (dest as FolderOk).folder;
  const destPath: string[] = destFolder
    ? [...(destFolder.path || []).map((p: any) => String(p)), String(destFolder._id)]
    : [];

  // Copying a folder into itself or a descendant would recurse forever.
  if (source.type === 'folder' && (destPath.includes(sourceId) || String(destFolder?._id) === sourceId)) {
    return { ok: false, status: 400, message: 'A folder cannot be copied into itself' };
  }

  const subtree = source.type === 'folder' ? await loadSubtree(userId, sourceId) : [];
  if (subtree.length + 1 > PERSONAL_FILES_MAX_COPY_ITEMS) {
    return { ok: false, status: 400, message: `A copy may not exceed ${PERSONAL_FILES_MAX_COPY_ITEMS} items` };
  }

  if (destPath.length + 1 > PERSONAL_FILES_MAX_DEPTH) {
    return { ok: false, status: 400, message: `Maximum folder depth of ${PERSONAL_FILES_MAX_DEPTH} reached` };
  }

  // Quota is checked for the WHOLE copy before a single byte is written.
  const bytesNeeded =
    (source.type === 'file' ? source.size || 0 : 0) +
    subtree.reduce((sum, d) => sum + (d.type === 'file' ? d.size || 0 : 0), 0);
  const usage = await computeUsage(userId);
  if (usage.usedBytes + bytesNeeded > usage.quotaBytes) {
    return {
      ok: false,
      status: 413,
      message: 'Storage quota exceeded - not enough space to complete this copy'
    };
  }

  const createdIds: string[] = [];
  const createdFiles: string[] = [];

  /** Duplicates one document under `newParentId`, returning the new document. */
  const duplicate = async (
    src: AnyDoc,
    newParentId: string | null,
    newParentPath: string[],
    overrideName?: string
  ): Promise<AnyDoc> => {
    const decryptedSrc = decryptPersonalFileFields({ ...src } as any);
    const doc = new PersonalFile({
      userId,
      type: src.type,
      name: 'pending',
      parentId: newParentId,
      path: newParentPath,
      mimeType: src.mimeType,
      size: src.size,
      isDeleted: false
    });
    const newId = doc._id.toString();
    const logicalName = overrideName ?? String(decryptedSrc.name || 'Untitled');
    doc.name = encryptField(logicalName, newId) as string;

    if (src.type === 'file') {
      // A copied file gets its OWN new physical file with a freshly generated
      // name - two records never share bytes on disk, so deleting one can never
      // strand the other.
      const sourceAbsolute = resolvePersonalFilePath(decryptedSrc.storagePath);
      const ext = path.extname(String(decryptedSrc.storagePath || ''));
      const safeExt = /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext.toLowerCase() : '';
      const newFilename = `${Date.now()}-${randomUUID()}${safeExt}`;
      const newAbsolute = path.join(PERSONAL_FILES_DIR, newFilename);
      if (sourceAbsolute) {
        await fsp.copyFile(sourceAbsolute, newAbsolute);
        createdFiles.push(`${PERSONAL_FILES_RELATIVE_PREFIX}/${newFilename}`);
      } else {
        logger.warn('Personal Files: copy source had an unresolvable storagePath');
      }
      doc.storagePath = encryptField(`${PERSONAL_FILES_RELATIVE_PREFIX}/${newFilename}`, newId);
      doc.originalName = encryptField(String(decryptedSrc.originalName || logicalName), newId);
    }

    await doc.save();
    createdIds.push(newId);
    return (typeof doc.toObject === 'function' ? doc.toObject() : doc) as AnyDoc;
  };

  try {
    const decryptedSource = decryptPersonalFileFields({ ...source } as any);
    const copyName = await nextAvailableName(userId, destParentId, String(decryptedSource.name || 'Untitled'));
    const root = await duplicate(source, destParentId, destPath, copyName);

    if (source.type === 'folder' && subtree.length > 0) {
      // Copy level by level so a child is always created after its new parent
      // exists, mapping old ids to new ids as we descend.
      const idMap = new Map<string, { id: string; path: string[] }>();
      idMap.set(sourceId, { id: String(root._id), path: [...destPath, String(root._id)] });

      const sorted = [...subtree].sort((a, b) => (a.path || []).length - (b.path || []).length);
      for (const node of sorted) {
        const oldParentId = node.parentId ? String(node.parentId) : null;
        const mapped = oldParentId ? idMap.get(oldParentId) : undefined;
        if (!mapped) {
          // Parent was not copied (should not happen for a consistent subtree) -
          // skip rather than attaching an orphan at the destination root.
          logger.warn('Personal Files: skipping subtree node with uncopied parent');
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
    // Roll back as completely as possible: remove every record and every physical
    // file this copy created, then report failure.
    logger.error('Personal Files: copy failed, rolling back', err);
    try {
      if (createdIds.length) await PersonalFile.deleteMany({ _id: { $in: createdIds }, userId });
    } catch (cleanupErr) {
      logger.error('Personal Files: rollback of copied records failed', cleanupErr);
    }
    for (const f of createdFiles) await safeUnlink(f);
    return { ok: false, status: 500, message: 'Failed to copy - no partial copy was kept' };
  }
}

/**
 * POST /api/personal-files/:id/copy   { parentId }
 */
export const copyItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = parseParentId(req.body?.parentId);
    if (!parsed.ok) {
      errorResponse(res, 'Invalid parentId', 400);
      return;
    }

    const result = await copyOne(userId, req.params.id, parsed.value);
    if (isOpFailure(result)) {
      errorResponse(res, result.message, result.status);
      return;
    }

    createdResponse(res, 'Copied successfully', { item: decryptToApi({ ...result.item }) });
  } catch (error) {
    logger.error('Error in copyItem:', error);
    internalServerErrorResponse(res, 'Failed to copy item');
  }
};

/** Soft-deletes one item and, for a folder, its entire subtree. */
async function softDeleteOne(
  userId: string,
  id: string
): Promise<{ ok: true; deletedCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await PersonalFile.findOne({ _id: id, userId, isDeleted: false }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  const now = new Date();
  await PersonalFile.updateOne({ _id: id, userId }, { $set: { isDeleted: true, deletedAt: now } });

  let deletedCount = 1;
  if (item.type === 'folder') {
    // Recursive soft delete via the materialised ancestor array - one indexed query.
    const result: AnyDoc = await PersonalFile.updateMany(
      { userId, path: String(item._id), isDeleted: false },
      { $set: { isDeleted: true, deletedAt: now } }
    );
    deletedCount += result?.modifiedCount || 0;
  }
  return { ok: true, deletedCount };
}

/**
 * DELETE /api/personal-files/:id
 * Soft delete (recycle bin). Nothing is removed from disk here.
 */
export const deleteItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const result = await softDeleteOne(userId, req.params.id);
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
 * GET /api/personal-files/recycle-bin
 * Lists trashed items whose parent is NOT itself trashed, so a deleted folder
 * appears once rather than once per descendant.
 */
export const listRecycleBin = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const rows = await PersonalFile.find({ userId, isDeleted: true }).sort({ deletedAt: -1 }).lean();
    const deleted = (rows || []) as AnyDoc[];

    const deletedIds = new Set(deleted.map((d) => String(d._id)));
    const roots = deleted.filter((d) => !d.parentId || !deletedIds.has(String(d.parentId)));

    successResponse(res, 'Recycle bin retrieved successfully', {
      items: roots.map(decryptToApi)
    });
  } catch (error) {
    logger.error('Error in listRecycleBin:', error);
    internalServerErrorResponse(res, 'Failed to retrieve recycle bin');
  }
};

/** Restores one item (and its subtree). */
async function restoreOne(
  userId: string,
  id: string
): Promise<{ ok: true; restoredCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await PersonalFile.findOne({ _id: id, userId, isDeleted: true }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found in the recycle bin' };

  // If the original parent is gone or still trashed, restore to the root instead
  // of resurrecting the item into an invisible location.
  let targetParentId: string | null = item.parentId ? String(item.parentId) : null;
  let targetPath: string[] = (item.path || []).map((p: any) => String(p));
  if (targetParentId) {
    const parent = (await PersonalFile.findOne({
      _id: targetParentId,
      userId,
      type: 'folder',
      isDeleted: false
    }).lean()) as AnyDoc | null;
    if (!parent) {
      targetParentId = null;
      targetPath = [];
    }
  }

  const decrypted = decryptPersonalFileFields({ ...item } as any);
  let restoreName = String(decrypted.name || 'Restored');
  if (await findNameConflict(userId, targetParentId, restoreName, String(item._id))) {
    restoreName = await nextAvailableName(userId, targetParentId, restoreName);
  }

  await PersonalFile.updateOne(
    { _id: id, userId },
    {
      $set: {
        isDeleted: false,
        parentId: targetParentId,
        path: targetPath,
        name: encryptField(restoreName, String(item._id)) as string
      },
      $unset: { deletedAt: 1 }
    }
  );

  let restoredCount = 1;
  if (item.type === 'folder') {
    const descendants = await loadSubtree(userId, String(item._id), true);
    if (descendants.length) {
      const itemId = String(item._id);
      const ops = descendants.map((d) => {
        const oldPath = (d.path || []).map((p: any) => String(p));
        const idx = oldPath.indexOf(itemId);
        const tail = idx === -1 ? [itemId] : oldPath.slice(idx);
        return {
          updateOne: {
            filter: { _id: d._id, userId },
            update: {
              $set: { isDeleted: false, path: [...targetPath, ...tail] },
              $unset: { deletedAt: 1 }
            }
          }
        };
      });
      await PersonalFile.bulkWrite(ops);
      restoredCount += descendants.length;
    }
  }
  return { ok: true, restoredCount };
}

/**
 * POST /api/personal-files/:id/restore
 */
export const restoreItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const result = await restoreOne(userId, req.params.id);
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
async function permanentDeleteOne(
  userId: string,
  id: string
): Promise<{ ok: true; deletedCount: number } | OpFailure> {
  if (!isValidId(id)) return { ok: false, status: 400, message: 'Invalid id' };

  const item = (await PersonalFile.findOne({ _id: id, userId }).lean()) as AnyDoc | null;
  if (!item) return { ok: false, status: 404, message: 'Item not found' };

  const subtree = item.type === 'folder' ? await loadSubtree(userId, String(item._id), true) : [];
  const all = [item, ...subtree];

  // The database is authoritative: records go first, then a best-effort physical
  // sweep. A file already missing from disk never fails the request.
  const ids = all.map((d) => d._id);
  await PersonalFile.deleteMany({ _id: { $in: ids }, userId });

  for (const doc of all) {
    if (doc.type !== 'file') continue;
    const decrypted = decryptPersonalFileFields({ ...doc } as any);
    await safeUnlink(decrypted.storagePath);
  }

  return { ok: true, deletedCount: all.length };
}

/**
 * DELETE /api/personal-files/:id/permanent
 */
export const permanentDeleteItem = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const result = await permanentDeleteOne(userId, req.params.id);
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
 * POST /api/personal-files/bulk   { operation, ids, parentId? }
 *
 * Batch counterpart of the single-item operations, for multi-selection. Every
 * item is processed through the SAME ownership-scoped helper as its single-item
 * route - there is no bulk shortcut around the authorization checks.
 */
export const bulkOperation = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { operation, ids } = req.body || {};
    const allowed = ['move', 'copy', 'delete', 'restore', 'permanentDelete'];
    if (!allowed.includes(operation)) {
      errorResponse(res, `operation must be one of: ${allowed.join(', ')}`, 400);
      return;
    }

    // A bulk request carries its operation in the BODY, so no single route-level
    // gate can cover it. Resolve the action here and apply exactly the same module
    // permission the equivalent single-item route would have required - a bulk call
    // must never be a way around a revoked permission.
    if (!(await hasPersonalFilesPermission(req, BULK_OPERATION_PERMISSION[operation]))) {
      errorResponse(res, 'You do not have permission to perform this action on Personal Files', 403);
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      errorResponse(res, 'ids must be a non-empty array', 400);
      return;
    }
    if (ids.length > PERSONAL_FILES_MAX_BULK_ITEMS) {
      errorResponse(res, `A bulk operation may not exceed ${PERSONAL_FILES_MAX_BULK_ITEMS} items`, 400);
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
          result = await moveOne(userId, id, destParentId);
          break;
        case 'copy':
          result = await copyOne(userId, id, destParentId);
          break;
        case 'delete':
          result = await softDeleteOne(userId, id);
          break;
        case 'restore':
          result = await restoreOne(userId, id);
          break;
        default:
          result = await permanentDeleteOne(userId, id);
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
 * GET /api/personal-files/search?q=
 *
 * Names are encrypted per-document with a random nonce, so they cannot be regex
 * matched in MongoDB. The query is therefore scoped to the caller FIRST (an
 * indexed `{ userId, isDeleted }` read), then names are decrypted and matched in
 * Node. There is deliberately no unscoped full-collection search path.
 */
export const searchItems = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length === 0) {
      successResponse(res, 'Search completed', { query: '', items: [] });
      return;
    }

    const rows = await PersonalFile.find({ userId, isDeleted: false }).lean();
    const needle = q.toLowerCase();
    const items = ((rows || []) as AnyDoc[])
      .map((r) => {
        decryptPersonalFileFields(r as any);
        return r;
      })
      .filter((r) => String(r.name || '').toLowerCase().includes(needle))
      .slice(0, 500)
      .map(toApiItem);

    successResponse(res, 'Search completed', { query: q, items });
  } catch (error) {
    logger.error('Error in searchItems:', error);
    internalServerErrorResponse(res, 'Failed to search files');
  }
};

/**
 * GET /api/personal-files/usage
 */
export const getUsage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const usage = await computeUsage(userId);
    const folderCount = await PersonalFile.countDocuments({ userId, type: 'folder', isDeleted: false });

    successResponse(res, 'Usage retrieved successfully', { ...usage, folderCount });
  } catch (error) {
    logger.error('Error in getUsage:', error);
    internalServerErrorResponse(res, 'Failed to retrieve storage usage');
  }
};

/**
 * GET /api/personal-files/:id/download?disposition=inline|attachment
 *
 * The ONLY way a personal file's bytes leave the server. Personal files are never
 * reachable through the public /uploads static mount: the physical filename is a
 * UUID, the stored path is encrypted, it is never sent to a client, and app.ts
 * blocks /uploads/personal-files outright.
 */
export const downloadFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;
    if (!isValidId(id)) {
      errorResponse(res, 'Invalid id', 400);
      return;
    }

    // Ownership is part of the query - a file belonging to someone else is simply
    // "not found", revealing nothing about whether that id exists.
    const file = (await PersonalFile.findOne({
      _id: id,
      userId,
      type: 'file',
      isDeleted: false
    }).lean()) as AnyDoc | null;
    if (!file) {
      notFoundResponse(res, 'File not found');
      return;
    }

    decryptPersonalFileFields(file as any);

    const absolute = resolvePersonalFilePath(file.storagePath);
    if (!absolute) {
      logger.error('Personal Files: stored path failed safe resolution');
      notFoundResponse(res, 'File not found');
      return;
    }

    if (!fs.existsSync(absolute)) {
      // The record survived but the bytes are gone. Report it honestly as a 404
      // rather than throwing - the database stays authoritative.
      logger.warn('Personal Files: physical file missing on download');
      notFoundResponse(res, 'The stored file is no longer available on the server');
      return;
    }

    const mimeType = String(file.mimeType || 'application/octet-stream');
    const wantsInline = req.query.disposition === 'inline';
    // Browser-active types (HTML/SVG/JS) are ALWAYS forced to download, whatever
    // the client asks for - rendering them inline would execute their script in
    // the app's own origin.
    const inline = wantsInline && !isForcedDownloadMime(mimeType);
    const safeName = sanitizeDispositionFilename(String(file.name || 'download'));

    res.setHeader('Content-Type', inline ? mimeType : 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`
    );
    // Never let a stored file be sniffed into a different, active type, embedded
    // in a frame, or cached by a shared proxy.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof file.size === 'number') res.setHeader('Content-Length', String(file.size));

    const stream = fs.createReadStream(absolute);
    stream.on('error', (err) => {
      logger.error('Personal Files: stream error during download', err);
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
