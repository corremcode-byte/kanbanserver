/**
 * Shared Files — single source of truth for every limit and policy constant.
 *
 * Shared Files is ONE GLOBAL repository visible to every user who holds the
 * `sharedFiles.view` module permission. It is deliberately a separate module from
 * Personal Files (a private, per-user drive): separate model, separate physical
 * directory, separate quota, separate configuration. Nothing here is imported by
 * Personal Files and nothing from Personal Files is imported here, so tuning one
 * module can never change the other.
 *
 * As with Personal Files, physical storage is FLAT: the logical folder tree lives
 * only in MongoDB (SharedFile.parentId / .path), so rename/move never touch disk.
 */

import path from 'path';

/** Absolute path of the flat physical storage directory. */
export const SHARED_FILES_DIR = path.join(process.cwd(), 'uploads', 'shared-files');

/** Relative storage prefix persisted in SharedFile.storagePath (never an absolute
 *  path, never a public URL — the download endpoint resolves it against
 *  SHARED_FILES_DIR at read time). */
export const SHARED_FILES_RELATIVE_PREFIX = 'shared-files';

/**
 * GLOBAL repository quota — the ceiling for the ENTIRE shared repository, across
 * every user. There is no per-user share of it: if User A uploads 500 MB, every
 * user sees 500 MB less headroom. Override with SHARED_FILES_QUOTA_BYTES.
 *
 * Defaults to the same 2 GB Personal Files uses per user, for consistency.
 */
export const SHARED_FILES_QUOTA_BYTES = Number(
  process.env.SHARED_FILES_QUOTA_BYTES || 2 * 1024 * 1024 * 1024
); // 2 GB

/** Largest single upload accepted. Enforced by multer AND re-checked in the
 *  controller against the real on-disk size. Override with
 *  SHARED_FILES_MAX_FILE_BYTES. */
export const SHARED_FILES_MAX_FILE_BYTES = Number(
  process.env.SHARED_FILES_MAX_FILE_BYTES || 100 * 1024 * 1024
); // 100 MB

export const SHARED_FILES_MAX_FILE_SIZE_LABEL = `${Math.round(
  SHARED_FILES_MAX_FILE_BYTES / (1024 * 1024)
)}MB`;

/** Maximum length of a single folder/file name (plaintext, after trimming). */
export const SHARED_FILES_MAX_NAME_LENGTH = 255;

/** Hard ceiling on folder nesting depth. */
export const SHARED_FILES_MAX_DEPTH = 32;

/** Maximum items accepted in one /bulk request. */
export const SHARED_FILES_MAX_BULK_ITEMS = 200;

/** Maximum number of documents a single recursive copy may create. */
export const SHARED_FILES_MAX_COPY_ITEMS = 1000;

/**
 * MIME types accepted on upload. Same everyday-document policy as Personal Files,
 * but kept as its OWN list (not imported) so tightening or loosening one module's
 * allow-list can never change the other's behaviour.
 */
export const SHARED_FILES_ALLOWED_MIME_TYPES: string[] = [
  // Images
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'image/tiff', 'image/heic', 'image/heif', 'image/avif', 'image/x-icon',
  'image/svg+xml', // accepted for storage, but NEVER served inline (see FORCE_DOWNLOAD)
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  // Text / data
  'text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values',
  'application/json', 'application/xml', 'text/xml',
  'text/html', 'text/css', 'text/javascript', 'application/javascript', // stored, force-downloaded
  // Archives
  'application/zip', 'application/x-zip', 'application/x-zip-compressed',
  'application/x-compressed', 'application/x-rar-compressed', 'application/vnd.rar',
  'application/x-7z-compressed', 'application/x-tar', 'application/gzip',
  'application/x-gzip', 'application/octet-stream',
  // Audio
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/aac', 'audio/flac', 'audio/mp4',
  // Video
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/mpeg', 'video/ogg',
];

/**
 * Types that are NEVER sent with `Content-Disposition: inline`, regardless of what
 * the client asks for. Rendering these would execute script in the app's origin —
 * and in a SHARED repository that would be stored XSS from one user against every
 * other user who previews the file. They are still downloadable, never rendered.
 */
export const SHARED_FILES_FORCE_DOWNLOAD_MIME_TYPES: string[] = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/xml',
  'text/xml',
  'application/xhtml',
];

/** Types safe to render inline in the preview modal (prefix match allowed for
 *  image/ audio/ video/). Anything not matching is offered as a download. */
export const SHARED_FILES_INLINE_SAFE_PREFIXES = ['image/', 'audio/', 'video/'];
export const SHARED_FILES_INLINE_SAFE_EXACT = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
];

export default {
  SHARED_FILES_DIR,
  SHARED_FILES_RELATIVE_PREFIX,
  SHARED_FILES_QUOTA_BYTES,
  SHARED_FILES_MAX_FILE_BYTES,
  SHARED_FILES_MAX_NAME_LENGTH,
  SHARED_FILES_MAX_DEPTH,
  SHARED_FILES_MAX_BULK_ITEMS,
  SHARED_FILES_MAX_COPY_ITEMS,
  SHARED_FILES_ALLOWED_MIME_TYPES,
  SHARED_FILES_FORCE_DOWNLOAD_MIME_TYPES,
};
