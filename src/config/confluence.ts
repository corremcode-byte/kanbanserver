/**
 * Confluence (knowledge pages) — single source of truth for every limit and policy
 * constant used by the module.
 *
 * Confluence is a structured-documentation module: rich-text pages arranged in a
 * parent/child tree, with a draft -> published workflow, labels, favourites,
 * comments and templates. It is NOT a file store — pages are MongoDB documents,
 * never uploaded files — and it shares nothing with Personal Files or Shared
 * Files beyond the generic helpers every module uses (field encryption, the
 * response envelope, the image compressor).
 */

import path from 'path';

/** Plaintext limits, enforced in confluenceController BEFORE encryption. */
export const CONFLUENCE_MAX_TITLE_LENGTH = 255;

/** Page body is sanitised HTML. 1,000,000 characters is far more than any real
 *  documentation page needs while still bounding the per-request decrypt/search
 *  cost. The JSON body parser for /api/confluence is sized to match (server.ts). */
export const CONFLUENCE_MAX_CONTENT_LENGTH = 1_000_000;

/** Request-body ceiling for /api/confluence JSON payloads. Must comfortably exceed
 *  CONFLUENCE_MAX_CONTENT_LENGTH once JSON-escaped. */
export const CONFLUENCE_JSON_BODY_LIMIT = '3mb';

export const CONFLUENCE_MAX_LABELS = 20;
export const CONFLUENCE_MAX_LABEL_LENGTH = 40;

export const CONFLUENCE_MAX_COMMENT_LENGTH = 5000;

/** Deepest allowed nesting (a root page has depth 0). */
export const CONFLUENCE_MAX_DEPTH = 10;

/** How many entries "Recent Pages" returns. */
export const CONFLUENCE_RECENT_LIMIT = 30;

/** Cap on search results returned in one response. */
export const CONFLUENCE_SEARCH_LIMIT = 100;

/** Inline page images (inserted from the editor). Stored flat, server-generated
 *  UUID filenames, re-encoded to WebP with EXIF orientation applied. */
export const CONFLUENCE_IMAGES_DIR = path.join(__dirname, '../../uploads/confluence-images');
export const CONFLUENCE_IMAGES_PUBLIC_PREFIX = '/uploads/confluence-images/';
export const CONFLUENCE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const CONFLUENCE_MAX_IMAGE_SIZE_LABEL = '10MB';
