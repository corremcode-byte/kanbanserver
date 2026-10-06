/**
 * Pure access + validation rules for the Confluence (knowledge pages) module.
 *
 * No I/O here — confluenceController loads documents and the caller's module
 * permissions, then asks these functions what the caller may see or do. Keeping
 * the rules in one pure module means the route gates, the controller and the
 * tests can never disagree about them.
 *
 * Permission flags (permissions.modules.confluence, administered in User
 * Management, fail-closed — see requireConfluencePermission):
 *   view    — use the module; read published pages
 *   create  — create pages (as drafts) and templates; edit/delete OWN drafts
 *   edit    — edit any page; see drafts
 *   comment — comment on published pages
 *   publish — publish drafts; see drafts
 *   delete  — delete any page (and its subtree), and any comment
 * A super admin passes every check, matching every other module gate.
 */

export interface ConfluencePerms {
  view: boolean;
  create: boolean;
  edit: boolean;
  comment: boolean;
  publish: boolean;
  delete: boolean;
}

export interface ConfluenceAccess {
  userId: string;
  isSuperAdmin: boolean;
  perms: ConfluencePerms;
}

/** The minimal page shape the rules need. */
export interface ConfluencePageLike {
  _id?: unknown;
  status?: string;
  isTemplate?: boolean;
  isDeleted?: boolean;
  createdBy?: unknown;
  restrictedTo?: unknown[];
  path?: unknown[];
}

const PERM_KEYS: (keyof ConfluencePerms)[] = ['view', 'create', 'edit', 'comment', 'publish', 'delete'];

/** Only an explicit `true` grants — a missing module/flag is a denial. */
export function normalizeConfluencePerms(raw: unknown): ConfluencePerms {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const perms = {} as ConfluencePerms;
  for (const key of PERM_KEYS) perms[key] = source[key] === true;
  return perms;
}

function idOf(value: unknown): string {
  if (value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)) {
    return String((value as { _id: unknown })._id);
  }
  return value === undefined || value === null ? '' : String(value);
}

export function isPageOwner(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  return !!access.userId && idOf(page.createdBy) === access.userId;
}

/** May this caller see unpublished (draft) content of this page? */
export function canSeeDrafts(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  return access.isSuperAdmin || access.perms.edit || access.perms.publish || isPageOwner(access, page);
}

/** Page-level view restriction. Empty list = unrestricted. The owner is always allowed. */
export function passesRestriction(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  if (access.isSuperAdmin) return true;
  const restricted = Array.isArray(page.restrictedTo) ? page.restrictedTo : [];
  if (restricted.length === 0) return true;
  if (isPageOwner(access, page)) return true;
  return restricted.some((u) => idOf(u) === access.userId);
}

/** Visibility of the page itself, ignoring its ancestors. */
export function isSelfVisible(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  if (!page || page.isDeleted) return false;
  if (!passesRestriction(access, page)) return false;
  if (page.isTemplate) return true;
  return page.status === 'published' || canSeeDrafts(access, page);
}

/**
 * Full visibility: the page AND every ancestor must be visible. A restriction or
 * an unpublished parent therefore hides the whole branch beneath it. `byId` must
 * contain the live (non-deleted) pages; a missing ancestor means it was deleted,
 * which hides the descendant too.
 */
export function isVisibleWithAncestors(
  access: ConfluenceAccess,
  page: ConfluencePageLike,
  byId: Map<string, ConfluencePageLike>
): boolean {
  if (!isSelfVisible(access, page)) return false;
  if (page.isTemplate) return true;
  const ancestors = Array.isArray(page.path) ? page.path : [];
  for (const ancestorId of ancestors) {
    const ancestor = byId.get(idOf(ancestorId));
    if (!ancestor || !isSelfVisible(access, ancestor)) return false;
  }
  return true;
}

export function canEditPage(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  if (access.isSuperAdmin || access.perms.edit) return true;
  return access.perms.create && isPageOwner(access, page);
}

export function canPublishPage(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  if (page.isTemplate) return false;
  return canEditPage(access, page) && (access.isSuperAdmin || access.perms.publish);
}

/**
 * Holders of `delete` may delete any page with its subtree. Without it, an owner
 * holding `create` may delete their own template, or their own never-published
 * draft as long as it has no live child pages.
 */
export function canDeletePage(
  access: ConfluenceAccess,
  page: ConfluencePageLike,
  hasLiveChildren: boolean
): boolean {
  if (access.isSuperAdmin || access.perms.delete) return true;
  if (!access.perms.create || !isPageOwner(access, page)) return false;
  if (page.isTemplate) return true;
  return page.status === 'draft' && !hasLiveChildren;
}

/**
 * Comments are allowed on published pages AND on drafts (so a never-published
 * page can be discussed during review). Drafts are only visible to people who may
 * see drafts (isSelfVisible), so comments on a draft can never reach anyone else.
 */
export function canCommentOnPage(access: ConfluenceAccess, page: ConfluencePageLike): boolean {
  if (page.isTemplate) return false;
  return access.isSuperAdmin || access.perms.comment;
}

export function canDeleteComment(access: ConfluenceAccess, authorId: unknown): boolean {
  return access.isSuperAdmin || access.perms.delete || idOf(authorId) === access.userId;
}

/* ---------------------------------------------------------------------------
   Input validation
   --------------------------------------------------------------------------- */

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** True for the failure branch. strictNullChecks is off in this project, so
 *  discriminated unions are narrowed with explicit guards (same convention as
 *  sharedFilesController). */
export function isInvalid<T>(result: Validated<T>): result is { ok: false; error: string } {
  return result.ok === false;
}

export function validatePageTitle(raw: unknown, maxLength: number): Validated<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Title is required' };
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length === 0) return { ok: false, error: 'Title cannot be empty' };
  if (value.length > maxLength) return { ok: false, error: `Title is too long (max ${maxLength} characters)` };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, error: 'Title contains invalid characters' };
  return { ok: true, value };
}

// \p{M} (combining marks) is required for scripts such as Devanagari, where vowel
// signs are separate code points — without it "विकास" would be rejected.
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.&+#-]*$/u;

/**
 * Normalises a label list: trims/collapses whitespace, drops empties, de-duplicates
 * case-insensitively (keeping the first spelling), and enforces count/length and a
 * conservative character set.
 */
export function normalizeLabels(raw: unknown, maxLabels: number, maxLength: number): Validated<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Labels must be a list' };
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'Each label must be text' };
    const value = item.replace(/\s+/g, ' ').trim();
    if (value.length === 0) continue;
    if (value.length > maxLength) return { ok: false, error: `Label "${value.slice(0, 20)}…" is too long (max ${maxLength} characters)` };
    if (!LABEL_RE.test(value)) return { ok: false, error: `Label "${value}" contains unsupported characters` };
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(value);
  }
  if (labels.length > maxLabels) return { ok: false, error: `A page can have at most ${maxLabels} labels` };
  return { ok: true, value: labels };
}

/** True when every requested label (case-insensitive) is on the page. */
export function hasAllLabels(pageLabels: unknown, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set((Array.isArray(pageLabels) ? pageLabels : []).map((l) => String(l).toLowerCase()));
  return wanted.every((w) => have.has(w.toLowerCase()));
}

/** Parses a `labels` query value: comma-separated, trimmed, de-duplicated. */
export function parseLabelQuery(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = new Set<string>();
  for (const v of values) {
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => out.add(s));
  }
  return [...out];
}

/** Splits a search query into lower-cased terms. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** A ~`radius`*2 character plain-text excerpt around the first matching term. */
export function buildSnippet(text: string, terms: string[], radius = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (index === -1 || i < index)) index = i;
  }
  if (index === -1) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? '…' : '');
  const start = Math.max(0, index - radius);
  const end = Math.min(clean.length, index + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}
