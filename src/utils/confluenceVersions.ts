/**
 * Pure rules for Confluence page version history. No I/O — confluenceController
 * loads the page and versions and asks these functions what the numbers mean and
 * what the caller may do.
 *
 * Storage model: the page document holds the CURRENT published version (number
 * `currentVersion`); ConfluencePageVersion holds every SUPERSEDED one. A version
 * is never rewritten, and restoring never deletes anything — it publishes the old
 * content as a brand-new version.
 */

import { ConfluenceAccess, ConfluencePageLike, canEditPage, canPublishPage } from './confluenceAccess';

export interface VersionedPageLike extends ConfluencePageLike {
  currentVersion?: number | null;
}

/**
 * The current published version number of a page. 0 = never published (drafts and
 * templates have no history). A page published before version history existed has
 * no `currentVersion` and counts as version 1.
 */
export function currentVersionOf(page: VersionedPageLike): number {
  if (!page || page.isTemplate || page.status !== 'published') return 0;
  const n = Number(page.currentVersion);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Parses a version number from a URL segment. Null for anything that isn't a positive integer. */
export function parseVersionNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

export type RestoreMode = 'publish' | 'draft';

/**
 * What restoring an old version does for this caller:
 * - 'publish' — publishes the old content as a NEW version (needs edit + publish).
 * - 'draft'   — puts the old content in the page's draft (edit only); someone
 *               with publish makes it live later.
 * - null      — the caller may not restore (view-only), or the page has no history.
 */
export function restoreModeFor(access: ConfluenceAccess, page: VersionedPageLike): RestoreMode | null {
  if (currentVersionOf(page) === 0) return null;
  if (!canEditPage(access, page)) return null;
  return canPublishPage(access, page) ? 'publish' : 'draft';
}

export interface ArchivedVersionLike {
  version: number;
}

/**
 * The superseded versions worth listing for a page currently at `current`: newest
 * first, one per number, and never the current number itself (the page document
 * is the source of truth for the current version — an archive row with that
 * number can only be a leftover from an interrupted publish).
 */
export function supersededVersions<T extends ArchivedVersionLike>(archived: T[], current: number): T[] {
  const seen = new Set<number>();
  return archived
    .filter((v) => Number.isInteger(v.version) && v.version >= 1 && v.version < current)
    .sort((a, b) => b.version - a.version)
    .filter((v) => (seen.has(v.version) ? false : (seen.add(v.version), true)));
}
