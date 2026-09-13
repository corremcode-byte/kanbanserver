/**
 * Personal Files — single source of truth for every limit and policy constant.
 *
 * Quota / size limits are intentionally defined ONCE here and imported everywhere
 * (multer instance, controller pre-checks, the /usage endpoint) so there is no way
 * for the enforced limit and the reported limit to drift apart.
 *
 * Physical storage is deliberately FLAT: the logical folder tree lives only in
 * MongoDB (PersonalFile.parentId / .path). Renaming or moving a folder is a pure
 * database operation and never touches the filesystem.
 */

import path from 'path';

/** Absolute path of the flat physical storage directory. */
export const PERSONAL_FILES_DIR = path.join(process.cwd(), 'uploads', 'personal-files');

/** Relative storage prefix persisted in PersonalFile.storagePath (never an absolute
 *  path, never a public URL — the download endpoint resolves it against
 *  PERSONAL_FILES_DIR at read time). */
export const PERSONAL_FILES_RELATIVE_PREFIX = 'personal-files';

/** Per-user total storage quota. Override with PERSONAL_FILES_QUOTA_BYTES. */
export const PERSONAL_FILES_QUOTA_BYTES = Number(
  process.env.PERSONAL_FILES_QUOTA_BYTES || 2 * 1024 * 1024 * 1024
); // 2 GB

/** Largest single upload accepted. Enforced by multer AND re-checked in the
 *  controller against the real on-disk size. Override with
 *  PERSONAL_FILES_MAX_FILE_BYTES. */
export const PERSONAL_FILES_MAX_FILE_BYTES = Number(
  process.env.PERSONAL_FILES_MAX_FILE_BYTES || 100 * 1024 * 1024
); // 100 MB

export const PERSONAL_FILES_MAX_FILE_SIZE_LABEL = `${Math.round(
  PERSONAL_FILES_MAX_FILE_BYTES / (1024 * 1024)
)}MB`;

/** Maximum length of a single folder/file name (plaintext, after trimming). */
export const PERSONAL_FILES_MAX_NAME_LENGTH = 255;

/** Hard ceiling on folder nesting depth — bounds recursive copy/move work and
 *  stops a client from building a pathologically deep tree. */
export const PERSONAL_FILES_MAX_DEPTH = 32;

/** Maximum items accepted in one /bulk request. */
export const PERSONAL_FILES_MAX_BULK_ITEMS = 200;

/** Maximum number of documents a single recursive copy may create. */
export const PERSONAL_FILES_MAX_COPY_ITEMS = 1000;

/**
 * MIME types accepted on upload. Mirrors the existing attachment filter in
 * middleware/upload.ts (so Personal Files accepts the same everyday documents the
 * rest of the app does) plus a few text formats that make sense for a personal
 * drive. Kept as its own list so tightening or loosening Personal Files can never
 * change task/chat/support upload behaviour.
 */
export const PERSONAL_FILES_ALLOWED_MIME_TYPES: string[] = [
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
 * the client asks for. These execute script in the browser's origin when rendered
 * (HTML/SVG can carry <script>, and a served .js can be <script src>'d), so serving
 * them inline would turn a user's own upload into stored XSS against the app.
 * They are still downloadable — just never rendered.
 */
export const PERSONAL_FILES_FORCE_DOWNLOAD_MIME_TYPES: string[] = [
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
export const PERSONAL_FILES_INLINE_SAFE_PREFIXES = ['image/', 'audio/', 'video/'];
export const PERSONAL_FILES_INLINE_SAFE_EXACT = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
];

export default {
  PERSONAL_FILES_DIR,
  PERSONAL_FILES_RELATIVE_PREFIX,
  PERSONAL_FILES_QUOTA_BYTES,
  PERSONAL_FILES_MAX_FILE_BYTES,
  PERSONAL_FILES_MAX_NAME_LENGTH,
  PERSONAL_FILES_MAX_DEPTH,
  PERSONAL_FILES_MAX_BULK_ITEMS,
  PERSONAL_FILES_MAX_COPY_ITEMS,
  PERSONAL_FILES_ALLOWED_MIME_TYPES,
  PERSONAL_FILES_FORCE_DOWNLOAD_MIME_TYPES,
};
