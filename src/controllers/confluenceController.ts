import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ConfluencePage, ConfluenceComment, ConfluencePageView, ConfluencePageVersion, User, AuditLog } from '../models';
import {
  successResponse,
  errorResponse,
  notFoundResponse,
  createdResponse,
  internalServerErrorResponse
} from '../utils/responses';
import { logger } from '../utils/logger';
import {
  encryptField,
  decryptField,
  decryptConfluencePageFields,
  decryptConfluenceCommentFields,
  decryptConfluenceVersionFields
} from '../utils/fieldEncryption';
import {
  currentVersionOf,
  parseVersionNumber,
  restoreModeFor,
  supersededVersions
} from '../utils/confluenceVersions';
import {
  extractMentionIdsFromHtml,
  parseMentionInput,
  mentionsPresentInText,
  newlyMentioned
} from '../utils/confluenceMentions';
import { recordConfluenceActivity, ConfluenceActivityInput } from '../services/confluenceActivityService';
import {
  workflowStatusOf,
  isInReview,
  hasPendingDraft,
  canSubmitForReview,
  canReviewPage,
  canWithdrawReview,
  isDraftLocked,
  DRAFT_LOCKED_MESSAGE
} from '../utils/confluenceReview';
import { createNotification } from './notificationController';
import { whiteboardChange } from '../utils/confluenceWhiteboard';
import { structuredTableChange } from '../utils/confluenceStructuredTable';
import {
  emitConfluencePageChanged,
  revalidateConfluencePresence,
  type ConfluencePageChangeKind
} from '../socket/confluencePresence';
import { sanitizeConfluenceHTML, stripHtml } from '../middleware/sanitizeHtml';
import { compressUploadedImage } from '../utils/imageCompression';
import {
  CONFLUENCE_MAX_TITLE_LENGTH,
  CONFLUENCE_MAX_CONTENT_LENGTH,
  CONFLUENCE_MAX_LABELS,
  CONFLUENCE_MAX_LABEL_LENGTH,
  CONFLUENCE_MAX_COMMENT_LENGTH,
  CONFLUENCE_MAX_DEPTH,
  CONFLUENCE_RECENT_LIMIT,
  CONFLUENCE_SEARCH_LIMIT,
  CONFLUENCE_IMAGES_PUBLIC_PREFIX
} from '../config/confluence';
import {
  ConfluenceAccess,
  normalizeConfluencePerms,
  canSeeDrafts,
  isSelfVisible,
  isVisibleWithAncestors,
  canEditPage,
  canPublishPage,
  canDeletePage,
  canCommentOnPage,
  canDeleteComment,
  isPageOwner,
  validatePageTitle,
  normalizeLabels,
  hasAllLabels,
  parseLabelQuery,
  searchTerms,
  buildSnippet,
  isInvalid,
  Validated
} from '../utils/confluenceAccess';

/**
 * Confluence controller — company knowledge pages.
 *
 * Authorization has two layers:
 * 1. Route gates (routes/confluence.ts → requireConfluencePermission): may the
 *    caller use Confluence / create / comment at all?
 * 2. Page-level rules (utils/confluenceAccess.ts), applied here per document:
 *    draft visibility, page restrictions (inherited down the tree), owner-may-edit-
 *    own, who may publish/delete this page.
 *
 * A page the caller may not see is reported as 404, never 403, so its existence
 * is not revealed.
 *
 * Encrypted fields (title/content/draftTitle/draftContent, comment content) are
 * encrypted right before save and decrypted on the in-memory/lean document before
 * responding — the same convention as every other content module. Because they
 * are encrypted, search and title sorting happen in Node after decryption.
 */

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role?: string;
  };
}

type AnyDoc = Record<string, any>;

type UserRef = { _id: string; displayName: string } | null;

/* ---------------------------------------------------------------------------
   Request helpers
   --------------------------------------------------------------------------- */

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

function idStr(value: unknown): string {
  if (value && typeof value === 'object' && '_id' in (value as AnyDoc)) return String((value as AnyDoc)._id);
  return value === undefined || value === null ? '' : String(value);
}

/** Loads the caller's Confluence module permissions. Null = unauthenticated
 *  (a response has already been sent). */
async function loadAccess(req: AuthenticatedRequest, res: Response): Promise<ConfluenceAccess | null> {
  if (!req.user || !req.user._id) {
    errorResponse(res, 'Authentication required', 401);
    return null;
  }
  const isSuperAdmin = req.user.role === 'superadmin';
  let rawPerms: unknown = {};
  if (!isSuperAdmin) {
    const user = (await User.findById(req.user._id).select('permissions.modules.confluence').lean()) as AnyDoc | null;
    rawPerms = user?.permissions?.modules?.confluence;
  }
  return { userId: String(req.user._id), isSuperAdmin, perms: normalizeConfluencePerms(rawPerms) };
}

/** Normalises an incoming parentId. Root = null; clients may send null, "null", "" or omit it. */
function parseParentId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '' || raw === 'null' || raw === 'root') {
    return { ok: true, value: null };
  }
  if (isValidId(raw)) return { ok: true, value: raw as string };
  return { ok: false };
}

function validateContent(raw: unknown): Validated<string> {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'Content must be HTML text' };
  if (raw.length > CONFLUENCE_MAX_CONTENT_LENGTH) {
    return { ok: false, error: 'This page is too large to save. Split it into child pages.' };
  }
  return { ok: true, value: sanitizeConfluenceHTML(raw, CONFLUENCE_IMAGES_PUBLIC_PREFIX) };
}

function validateComment(raw: unknown): Validated<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Comment is required' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'Comment cannot be empty' };
  if (value.length > CONFLUENCE_MAX_COMMENT_LENGTH) {
    return { ok: false, error: `Comment is too long (max ${CONFLUENCE_MAX_COMMENT_LENGTH} characters)` };
  }
  return { ok: true, value };
}

/** Validates a list of user ids for a page restriction. */
async function validateRestrictedTo(raw: unknown): Promise<Validated<string[]>> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'restrictedTo must be a list of user ids' };
  const ids = [...new Set(raw.map((v) => String(v)))];
  if (ids.length > 500) return { ok: false, error: 'Too many users in the restriction' };
  if (!ids.every((id) => isValidId(id))) return { ok: false, error: 'restrictedTo contains an invalid user id' };
  if (ids.length === 0) return { ok: true, value: [] };
  const found = await User.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) return { ok: false, error: 'One or more selected users no longer exist' };
  return { ok: true, value: ids };
}

/* ---------------------------------------------------------------------------
   Loading + visibility
   --------------------------------------------------------------------------- */

const SKELETON_FIELDS = '_id parentId path status createdBy restrictedTo isTemplate isDeleted';

/** Live, non-template pages without their (large) bodies, keyed by id. */
async function loadLiveSkeleton(): Promise<Map<string, AnyDoc>> {
  const rows = ((await ConfluencePage.find({ isDeleted: false, isTemplate: false })
    .select(SKELETON_FIELDS)
    .lean()) || []) as AnyDoc[];
  return new Map(rows.map((r) => [String(r._id), r]));
}

/** Full visibility of one page: itself plus every ancestor. */
async function isPageVisible(access: ConfluenceAccess, page: AnyDoc): Promise<boolean> {
  if (!isSelfVisible(access, page)) return false;
  if (page.isTemplate || !Array.isArray(page.path) || page.path.length === 0) return true;
  const ancestors = ((await ConfluencePage.find({ _id: { $in: page.path }, isDeleted: false })
    .select(SKELETON_FIELDS)
    .lean()) || []) as AnyDoc[];
  const byId = new Map(ancestors.map((a) => [String(a._id), a]));
  return isVisibleWithAncestors(access, page, byId);
}

/** Loads a live page the caller can see, or sends 404 and returns null. */
async function loadVisiblePage(
  access: ConfluenceAccess,
  id: unknown,
  res: Response
): Promise<AnyDoc | null> {
  if (!isValidId(id)) {
    errorResponse(res, 'Invalid page id', 400);
    return null;
  }
  const page = (await ConfluencePage.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
  if (!page || !(await isPageVisible(access, page))) {
    notFoundResponse(res, 'Page not found');
    return null;
  }
  return page;
}

/** Resolves user ids to { _id, displayName } in one query. */
async function resolveUsers(ids: unknown[]): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.map(idStr).filter((id) => isValidId(id)))];
  const map = new Map<string, UserRef>();
  if (unique.length === 0) return map;
  try {
    const users = ((await User.find({ _id: { $in: unique } }).select('_id displayName').lean()) || []) as AnyDoc[];
    for (const u of users) map.set(String(u._id), { _id: String(u._id), displayName: u.displayName || 'Unknown user' });
  } catch (error) {
    logger.warn('Confluence: user lookup failed; names will show as unknown', error);
  }
  return map;
}

function userRef(map: Map<string, UserRef>, id: unknown): UserRef {
  const key = idStr(id);
  if (!key) return null;
  return map.get(key) || { _id: key, displayName: 'Unknown user' };
}

/* ---------------------------------------------------------------------------
   Collaboration: who else can see a page, mentions, activity
   --------------------------------------------------------------------------- */

/** Another user's Confluence access, built from their stored permissions. */
function accessForUser(user: AnyDoc): ConfluenceAccess {
  return {
    userId: String(user._id),
    isSuperAdmin: user.role === 'superadmin',
    perms: normalizeConfluencePerms(user.permissions?.modules?.confluence)
  };
}

/** The page's live ancestors (skeleton fields), for judging visibility for OTHER users. */
async function loadAncestorMap(page: AnyDoc): Promise<Map<string, AnyDoc>> {
  if (page.isTemplate || !Array.isArray(page.path) || page.path.length === 0) return new Map();
  const rows = ((await ConfluencePage.find({ _id: { $in: page.path }, isDeleted: false })
    .select(SKELETON_FIELDS)
    .lean()) || []) as AnyDoc[];
  return new Map(rows.map((r) => [String(r._id), r]));
}

/** True when `access` may open `page` right now: module view AND page-level visibility. */
function canUserOpen(access: ConfluenceAccess, page: AnyDoc, ancestors: Map<string, AnyDoc>): boolean {
  if (!access.isSuperAdmin && !access.perms.view) return false;
  return isVisibleWithAncestors(access, page, ancestors);
}

const USER_ACCESS_FIELDS = '_id displayName email role isActive permissions.modules.confluence';

/** Of `userIds`, the ACTIVE users who can open `page` right now. Everyone else is dropped. */
async function usersWhoCanOpenPage(page: AnyDoc, userIds: string[]): Promise<AnyDoc[]> {
  const ids = [...new Set(userIds.filter((id) => isValidId(id)))];
  if (ids.length === 0) return [];
  const users = ((await User.find({ _id: { $in: ids }, isActive: true }).select(USER_ACCESS_FIELDS).lean()) || []) as AnyDoc[];
  const ancestors = await loadAncestorMap(page);
  return users.filter((u) => canUserOpen(accessForUser(u), page, ancestors));
}

/** The page title anyone who can open the page may see (never a draft title). */
function publicTitleOf(page: AnyDoc): string | undefined {
  if (!page.isTemplate && page.status !== 'published') return undefined;
  return decryptField(page.title, String(page._id)) || 'Untitled';
}

/** Activity entry for this page; draft-stage pages are flagged draftOnly and carry no title. */
function activityFor(
  page: AnyDoc,
  access: ConfluenceAccess,
  action: ConfluenceActivityInput['action'],
  details?: ConfluenceActivityInput['details'],
  draftOnly?: boolean
): Promise<void> {
  const isDraftStage = draftOnly ?? (!page.isTemplate && page.status !== 'published');
  return recordConfluenceActivity({
    pageId: String(page._id),
    actorId: access.userId,
    action,
    pageTitle: isDraftStage ? undefined : publicTitleOf(page),
    draftOnly: isDraftStage,
    details
  });
}

/** Actions that mean "only edited the contents of an existing block". */
const BLOCK_EDIT_ACTIONS = new Set<string>(['confluence_whiteboard_edited', 'confluence_table_edited']);

/**
 * What a save did to the page's content blocks (whiteboards, structured
 * tables) — one entry per block kind, counts only, never labels or cell values.
 * Block edits are otherwise ordinary content changes: same draft, same
 * versions, same locks.
 */
function blockChanges(beforeHtml: string | undefined, afterHtml: string | undefined) {
  return [whiteboardChange(beforeHtml, afterHtml), structuredTableChange(beforeHtml, afterHtml)]
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

async function recordBlockActivity(
  page: AnyDoc,
  access: ConfluenceAccess,
  beforeHtml: string | undefined,
  afterHtml: string | undefined,
  draftOnly?: boolean
): Promise<void> {
  for (const change of blockChanges(beforeHtml, afterHtml)) {
    await activityFor(page, access, change.action, change.details, draftOnly);
  }
}

/**
 * Sends `confluence_mention` notifications to `recipientIds` — after removing the
 * actor themselves and anyone who cannot open the page right now (inactive, no
 * Confluence view, page restriction, unpublished page). Uses the app's single
 * notification system (createNotification: bell + socket + push). Failures are
 * logged, never thrown — a notification problem must not fail the user's save.
 * Returns the ids actually notified.
 */
async function notifyMentions(
  page: AnyDoc,
  actor: { userId: string; displayName?: string },
  recipientIds: string[],
  commentId?: string
): Promise<string[]> {
  try {
    const candidates = recipientIds.filter((id) => id !== actor.userId);
    if (candidates.length === 0) return [];
    const recipients = await usersWhoCanOpenPage(page, candidates);
    const title = publicTitleOf(page) || 'a Confluence page';
    const actorName = actor.displayName || 'Someone';
    await Promise.all(
      recipients.map((u) =>
        createNotification({
          userId: String(u._id),
          type: 'confluence_mention',
          title: 'You were mentioned in Confluence',
          message: commentId
            ? `${actorName} mentioned you in a comment on "${title}"`
            : `${actorName} mentioned you in "${title}"`,
          metadata: {
            confluencePageId: String(page._id),
            confluenceCommentId: commentId,
            confluencePageTitle: title,
            actionBy: actor.userId,
            actionByName: actorName
          }
        }).catch((error: unknown) => logger.warn(`Confluence: failed to notify ${u._id} of a mention`, error))
      )
    );
    return recipients.map((u) => String(u._id));
  } catch (error) {
    logger.warn('Confluence: failed to send mention notifications', error);
    return [];
  }
}

type ConfluenceNotificationType = 'confluence_review_requested' | 'confluence_changes_requested' | 'confluence_page_approved';

/**
 * Sends one review-workflow notification to each of `recipientIds` — after
 * dropping the actor and anyone who cannot open the page AND see its drafts right
 * now (review notifications are about unpublished content). Uses the app's
 * single notification system. Never throws. Returns the ids actually notified.
 */
async function notifyReviewEvent(
  page: AnyDoc,
  actor: { userId: string; displayName?: string },
  recipientIds: string[],
  type: ConfluenceNotificationType,
  buildMessage: (actorName: string, title: string) => { title: string; message: string }
): Promise<string[]> {
  try {
    const candidates = [...new Set(recipientIds)].filter((id) => id && id !== actor.userId);
    if (candidates.length === 0) return [];
    const openers = await usersWhoCanOpenPage(page, candidates);
    const recipients = openers.filter((u) => canSeeDrafts(accessForUser(u), page));
    // Every recipient may see drafts, so the working title is safe to show them.
    const pageTitle = (decryptField(page.status === 'published' && !page.hasDraft ? page.title : page.draftTitle || page.title, String(page._id))) || 'Untitled';
    const actorName = actor.displayName || 'Someone';
    const { title, message } = buildMessage(actorName, pageTitle);
    await Promise.all(
      recipients.map((u) =>
        createNotification({
          userId: String(u._id),
          type,
          title,
          message,
          metadata: {
            confluencePageId: String(page._id),
            confluencePageTitle: pageTitle,
            actionBy: actor.userId,
            actionByName: actorName
          }
        }).catch((error: unknown) => logger.warn(`Confluence: failed to send ${type} to ${u._id}`, error))
      )
    );
    return recipients.map((u) => String(u._id));
  } catch (error) {
    logger.warn(`Confluence: failed to send ${type} notifications`, error);
    return [];
  }
}

/** Cap on how many reviewers one submission notifies. */
const MAX_REVIEW_NOTIFICATIONS = 50;

/**
 * Everyone who could approve this page: active users holding the publish flag who
 * may also edit it (canPublishPage) — the same rule the approve endpoint enforces.
 * Super admins are not paged on every submission unless they hold the flag.
 */
async function reviewersFor(page: AnyDoc): Promise<string[]> {
  const users = ((await User.find({ isActive: true, 'permissions.modules.confluence.publish': true })
    .select(USER_ACCESS_FIELDS)
    .limit(500)
    .lean()) || []) as AnyDoc[];
  return users
    .filter((u) => canPublishPage(accessForUser(u), page))
    .slice(0, MAX_REVIEW_NOTIFICATIONS)
    .map((u) => String(u._id));
}

/* ---------------------------------------------------------------------------
   Response shaping
   --------------------------------------------------------------------------- */

/** The title this caller should see: a never-published page only has its draft
 *  title (and is only ever shown to someone who may see drafts). */
function displayTitle(page: AnyDoc): string {
  if (!page.isTemplate && page.status === 'draft') return page.draftTitle || 'Untitled';
  return page.title || 'Untitled';
}

/** The body this caller should read in the page view. */
function displayContent(page: AnyDoc): string {
  if (!page.isTemplate && page.status === 'draft') return page.draftContent || '';
  return page.content || '';
}

function excerptOf(html: string, length = 220): string {
  const text = stripHtml(html || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

interface ShapeOptions {
  includeContent?: boolean;
  includeExcerpt?: boolean;
  hasLiveChildren?: boolean;
}

/**
 * The client-safe page shape. Draft fields are ONLY included when the caller may
 * see drafts; `restrictedTo` ids only when the caller may edit the page.
 * `page` must already be decrypted.
 */
/** Every user a page response may name (resolved in one query by resolveUsers). */
function pageUserIds(page: AnyDoc): unknown[] {
  return [page.createdBy, page.updatedBy, page.publishedBy, page.reviewSubmittedBy, page.lastReviewedBy];
}

function toApiPage(page: AnyDoc, access: ConfluenceAccess, users: Map<string, UserRef>, opts: ShapeOptions = {}) {
  const seeDrafts = canSeeDrafts(access, page);
  const editable = canEditPage(access, page);
  const restrictedTo = Array.isArray(page.restrictedTo) ? page.restrictedTo.map(idStr) : [];

  const shaped: AnyDoc = {
    _id: String(page._id),
    title: displayTitle(page),
    status: page.status,
    isTemplate: !!page.isTemplate,
    hasDraft: seeDrafts ? !!page.hasDraft : false,
    parentId: page.parentId ? String(page.parentId) : null,
    path: Array.isArray(page.path) ? page.path.map(idStr) : [],
    labels: Array.isArray(page.labels) ? page.labels : [],
    createdBy: userRef(users, page.createdBy),
    updatedBy: userRef(users, page.updatedBy),
    publishedBy: userRef(users, page.publishedBy),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    publishedAt: page.publishedAt || null,
    currentVersion: currentVersionOf(page),
    restoredFromVersion: page.restoredFromVersion || null,
    isFavorite: Array.isArray(page.favoritedBy) && page.favoritedBy.some((u: unknown) => idStr(u) === access.userId),
    isRestricted: restrictedTo.length > 0,
    isOwner: isPageOwner(access, page),
    permissions: {
      canEdit: editable,
      canPublish: canPublishPage(access, page),
      canDelete: canDeletePage(access, page, !!opts.hasLiveChildren),
      canComment: canCommentOnPage(access, page),
      canRestrict: editable && !page.isTemplate,
      canSubmitReview: canSubmitForReview(access, page),
      canReview: canReviewPage(access, page),
      canWithdrawReview: canWithdrawReview(access, page)
    },
    // Draft / In Review / Published — as THIS caller may know it (never reveals a
    // pending review to someone who cannot see drafts).
    workflowStatus: workflowStatusOf(access, page)
  };

  if (editable) shaped.restrictedTo = restrictedTo;

  // Saving a draft bumps updatedBy/updatedAt. Someone who may not see drafts must
  // not learn from those that unpublished work exists (or who is doing it): for
  // them "last updated" is the published version.
  if (!seeDrafts && page.status === 'published' && !page.isTemplate) {
    shaped.updatedBy = userRef(users, page.publishedBy || page.updatedBy);
    shaped.updatedAt = page.publishedAt || page.updatedAt;
  }

  // Review details are draft information: only for people who may see drafts.
  if (seeDrafts && !page.isTemplate) {
    shaped.review = {
      state: isInReview(page) ? 'in_review' : null,
      submittedBy: userRef(users, page.reviewSubmittedBy),
      submittedAt: page.reviewSubmittedAt || null,
      lastOutcome: page.lastReviewOutcome || null,
      lastReviewedBy: userRef(users, page.lastReviewedBy),
      lastReviewedAt: page.lastReviewedAt || null,
      note: page.reviewNote ? decryptField(page.reviewNote, String(page._id)) || null : null
    };
  }

  if (opts.includeContent) {
    shaped.content = displayContent(page);
    if (seeDrafts && page.hasDraft && page.status === 'published') {
      shaped.draft = { title: page.draftTitle || '', content: page.draftContent || '' };
    }
  }
  if (opts.includeExcerpt) {
    shaped.excerpt = excerptOf(displayContent(page));
  }
  return shaped;
}

/** Decrypts + resolves users + shapes a whole list. */
async function toApiList(pages: AnyDoc[], access: ConfluenceAccess, opts: ShapeOptions = {}) {
  pages.forEach((p) => decryptConfluencePageFields(p as any));
  const users = await resolveUsers(pages.flatMap(pageUserIds));
  return pages.map((p) => toApiPage(p, access, users, opts));
}

function byTitle(a: AnyDoc, b: AnyDoc): number {
  return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base', numeric: true });
}

function byRecentActivity(a: AnyDoc, b: AnyDoc): number {
  const at = new Date(a.publishedAt || a.updatedAt || 0).getTime();
  const bt = new Date(b.publishedAt || b.updatedAt || 0).getTime();
  return bt - at;
}

/** Visible, live, non-template pages (full documents). */
async function loadVisiblePages(access: ConfluenceAccess, projection?: string): Promise<AnyDoc[]> {
  const query = ConfluencePage.find({ isDeleted: false, isTemplate: false });
  if (projection) query.select(projection);
  const rows = ((await query.lean()) || []) as AnyDoc[];
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return rows.filter((r) => isVisibleWithAncestors(access, r, byId));
}

/* ---------------------------------------------------------------------------
   Middleware
   --------------------------------------------------------------------------- */

/**
 * Gate for actions that write page content but aren't tied to a specific page
 * yet (image upload): requires `create` OR `edit`. Runs BEFORE multer so a
 * forbidden upload never writes bytes to disk.
 */
export const requireConfluenceAuthor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    if (access.isSuperAdmin || access.perms.create || access.perms.edit) {
      next();
      return;
    }
    errorResponse(res, 'You do not have permission to add content in Confluence', 403);
  } catch (error) {
    logger.error('Error checking Confluence author permission:', error);
    errorResponse(res, 'Failed to verify permissions', 500);
  }
};

/* ---------------------------------------------------------------------------
   Lists, tree, search, labels
   --------------------------------------------------------------------------- */

/**
 * GET /api/confluence/pages?scope=all|mine|recent|favorites|templates&labels=a,b
 */
export const listPages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
    const labels = parseLabelQuery(req.query.labels);

    if (scope === 'templates') {
      const rows = ((await ConfluencePage.find({ isDeleted: false, isTemplate: true }).lean()) || []) as AnyDoc[];
      const visible = rows.filter((r) => isSelfVisible(access, r) && hasAllLabels(r.labels, labels));
      const pages = await toApiList(visible, access, { includeExcerpt: true });
      pages.sort(byTitle);
      successResponse(res, 'Templates retrieved successfully', { pages });
      return;
    }

    let visible = await loadVisiblePages(access);
    visible = visible.filter((p) => hasAllLabels(p.labels, labels));

    if (scope === 'mine') {
      visible = visible.filter((p) => isPageOwner(access, p));
    } else if (scope === 'favorites') {
      visible = visible.filter((p) => (p.favoritedBy || []).some((u: unknown) => idStr(u) === access.userId));
    } else if (scope === 'recent') {
      const views = ((await ConfluencePageView.find({ userId: access.userId })
        .sort({ viewedAt: -1 })
        .limit(CONFLUENCE_RECENT_LIMIT * 3)
        .lean()) || []) as AnyDoc[];
      const byId = new Map(visible.map((p) => [String(p._id), p]));
      const recent: AnyDoc[] = [];
      for (const v of views) {
        const page = byId.get(String(v.pageId));
        if (page) recent.push({ ...page, viewedAt: v.viewedAt });
        if (recent.length >= CONFLUENCE_RECENT_LIMIT) break;
      }
      const shaped = await toApiList(recent, access, { includeExcerpt: true });
      shaped.forEach((s, i) => { s.viewedAt = recent[i].viewedAt; });
      successResponse(res, 'Recent pages retrieved successfully', { pages: shaped });
      return;
    }

    const pages = await toApiList(visible, access, { includeExcerpt: true });
    if (scope === 'favorites') pages.sort(byTitle);
    else pages.sort(byRecentActivity);
    successResponse(res, 'Pages retrieved successfully', { pages });
  } catch (error) {
    logger.error('Error in listPages:', error);
    internalServerErrorResponse(res, 'Failed to retrieve pages');
  }
};

/**
 * GET /api/confluence/pages/tree — every visible page (no bodies) for the
 * hierarchy sidebar. The client assembles the tree from parentId.
 */
export const getTree = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const visible = await loadVisiblePages(access, '-content -draftContent');
    visible.forEach((p) => decryptConfluencePageFields(p as any));
    const nodes = visible
      .map((p) => ({
        _id: String(p._id),
        title: displayTitle(p),
        parentId: p.parentId ? String(p.parentId) : null,
        status: p.status,
        hasDraft: canSeeDrafts(access, p) ? !!p.hasDraft : false,
        inReview: canSeeDrafts(access, p) ? isInReview(p) : false,
        isRestricted: Array.isArray(p.restrictedTo) && p.restrictedTo.length > 0
      }))
      .sort(byTitle);
    successResponse(res, 'Page tree retrieved successfully', { nodes });
  } catch (error) {
    logger.error('Error in getTree:', error);
    internalServerErrorResponse(res, 'Failed to retrieve page tree');
  }
};

/**
 * GET /api/confluence/pages/search?q=&labels=a,b
 *
 * Searches page title, page body text and labels. Every term must match
 * (anywhere across those fields). Callers who may see a page's draft also match
 * against the draft. Title matches rank first.
 */
export const searchPages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const labels = parseLabelQuery(req.query.labels);
    const terms = searchTerms(q);
    if (terms.length === 0 && labels.length === 0) {
      successResponse(res, 'Search completed', { query: q, results: [] });
      return;
    }

    const candidates = (await loadVisiblePages(access)).filter((p) => hasAllLabels(p.labels, labels));
    candidates.forEach((p) => decryptConfluencePageFields(p as any));

    const scored: { page: AnyDoc; score: number; snippet: string }[] = [];
    for (const page of candidates) {
      const title = displayTitle(page);
      const bodyText = stripHtml(displayContent(page));
      const draftVisible = canSeeDrafts(access, page) && page.hasDraft && page.status === 'published';
      const draftTitle = draftVisible ? page.draftTitle || '' : '';
      const draftText = draftVisible ? stripHtml(page.draftContent || '') : '';
      const labelText = (page.labels || []).join(' ');

      const titleLower = `${title} ${draftTitle}`.toLowerCase();
      const labelLower = labelText.toLowerCase();
      const haystack = `${titleLower} ${bodyText.toLowerCase()} ${draftText.toLowerCase()} ${labelLower}`;
      if (!terms.every((t) => haystack.includes(t))) continue;

      let score = 0;
      for (const t of terms) {
        if (titleLower.includes(t)) score += 10;
        if (labelLower.includes(t)) score += 5;
        if (bodyText.toLowerCase().includes(t)) score += 1;
      }
      const snippetSource = bodyText || draftText;
      scored.push({ page, score, snippet: buildSnippet(snippetSource, terms) });
    }

    scored.sort((a, b) => b.score - a.score || byRecentActivity(a.page, b.page));
    const top = scored.slice(0, CONFLUENCE_SEARCH_LIMIT);
    const users = await resolveUsers(top.flatMap((s) => pageUserIds(s.page)));
    const results = top.map((s) => ({ ...toApiPage(s.page, access, users), snippet: s.snippet }));

    successResponse(res, 'Search completed', { query: q, results });
  } catch (error) {
    logger.error('Error in searchPages:', error);
    internalServerErrorResponse(res, 'Failed to search pages');
  }
};

/** GET /api/confluence/labels — labels in use across the caller's visible pages, with counts. */
export const listLabels = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const visible = await loadVisiblePages(access, SKELETON_FIELDS + ' labels');
    const counts = new Map<string, { label: string; count: number }>();
    for (const page of visible) {
      for (const label of page.labels || []) {
        const key = String(label).toLowerCase();
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { label: String(label), count: 1 });
      }
    }
    const labels = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    successResponse(res, 'Labels retrieved successfully', { labels });
  } catch (error) {
    logger.error('Error in listLabels:', error);
    internalServerErrorResponse(res, 'Failed to retrieve labels');
  }
};

/**
 * GET /api/confluence/users — active users who can use Confluence (for the page
 * restriction picker). Only id, display name and email are exposed.
 */
export const listConfluenceUsers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const users = ((await User.find({
      isActive: true,
      $or: [{ 'permissions.modules.confluence.view': true }, { role: 'superadmin' }]
    })
      .select('_id displayName email')
      .sort({ displayName: 1 })
      .lean()) || []) as AnyDoc[];
    successResponse(res, 'Users retrieved successfully', {
      users: users.map((u) => ({ _id: String(u._id), displayName: u.displayName || u.email, email: u.email }))
    });
  } catch (error) {
    logger.error('Error in listConfluenceUsers:', error);
    internalServerErrorResponse(res, 'Failed to retrieve users');
  }
};

/* ---------------------------------------------------------------------------
   Single page
   --------------------------------------------------------------------------- */

/**
 * GET /api/confluence/pages/:id — the page, its breadcrumb and its visible
 * children. Records the view for "Recent Pages".
 */
export const getPage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const [ancestors, children, liveChildCount] = await Promise.all([
      page.path?.length
        ? ConfluencePage.find({ _id: { $in: page.path }, isDeleted: false }).select('-content -draftContent').lean()
        : Promise.resolve([]),
      page.isTemplate
        ? Promise.resolve([])
        : ConfluencePage.find({ parentId: page._id, isDeleted: false, isTemplate: false })
            .select('-content -draftContent')
            .lean(),
      page.isTemplate ? Promise.resolve(0) : ConfluencePage.countDocuments({ parentId: page._id, isDeleted: false })
    ]);

    decryptConfluencePageFields(page as any);
    const users = await resolveUsers(pageUserIds(page));
    const shaped = toApiPage(page, access, users, { includeContent: true, hasLiveChildren: liveChildCount > 0 });

    const ancestorById = new Map(((ancestors || []) as AnyDoc[]).map((a) => [String(a._id), a]));
    const breadcrumb = (page.path || [])
      .map((id: unknown) => ancestorById.get(idStr(id)))
      .filter(Boolean)
      .map((a: AnyDoc) => {
        decryptConfluencePageFields(a as any);
        return { _id: String(a._id), title: displayTitle(a) };
      });

    const childList = ((children || []) as AnyDoc[])
      .filter((c) => isSelfVisible(access, c))
      .map((c) => {
        decryptConfluencePageFields(c as any);
        return { _id: String(c._id), title: displayTitle(c), status: c.status };
      })
      .sort(byTitle);

    // Best-effort: a failed view record must never fail the page load.
    ConfluencePageView.updateOne(
      { userId: access.userId, pageId: page._id },
      { $set: { viewedAt: new Date() } },
      { upsert: true }
    ).catch((error: unknown) => logger.warn('Confluence: failed to record page view', error));

    successResponse(res, 'Page retrieved successfully', { page: shaped, breadcrumb, children: childList });
  } catch (error) {
    logger.error('Error in getPage:', error);
    internalServerErrorResponse(res, 'Failed to retrieve page');
  }
};

/**
 * POST /api/confluence/pages
 * body: { title, content, parentId?, labels?, isTemplate?, publish?, restrictedTo? }
 *
 * A page is created as a draft unless `publish` is true (requires `publish`).
 * A template is saved directly (templates have no draft stage) and has no parent.
 */
export const createPage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const titleResult = validatePageTitle(req.body?.title, CONFLUENCE_MAX_TITLE_LENGTH);
    if (isInvalid(titleResult)) { errorResponse(res, titleResult.error, 400); return; }
    const contentResult = validateContent(req.body?.content);
    if (isInvalid(contentResult)) { errorResponse(res, contentResult.error, 400); return; }
    const labelsResult = normalizeLabels(req.body?.labels, CONFLUENCE_MAX_LABELS, CONFLUENCE_MAX_LABEL_LENGTH);
    if (isInvalid(labelsResult)) { errorResponse(res, labelsResult.error, 400); return; }

    const isTemplate = req.body?.isTemplate === true;
    const publish = !isTemplate && req.body?.publish === true;
    if (publish && !(access.isSuperAdmin || access.perms.publish)) {
      errorResponse(res, 'You do not have permission to publish pages. Save it as a draft instead.', 403);
      return;
    }

    let parent: AnyDoc | null = null;
    if (!isTemplate) {
      const parentResult = parseParentId(req.body?.parentId);
      if (parentResult.ok === false) { errorResponse(res, 'Invalid parent page', 400); return; }
      if (parentResult.value) {
        parent = (await ConfluencePage.findOne({ _id: parentResult.value, isDeleted: false, isTemplate: false }).lean()) as AnyDoc | null;
        if (!parent || !(await isPageVisible(access, parent))) {
          notFoundResponse(res, 'Parent page not found');
          return;
        }
        if ((parent.path || []).length + 1 >= CONFLUENCE_MAX_DEPTH) {
          errorResponse(res, `Pages cannot be nested more than ${CONFLUENCE_MAX_DEPTH} levels deep`, 400);
          return;
        }
      }
    }

    const restrictedResult = isTemplate ? ({ ok: true, value: [] } as Validated<string[]>) : await validateRestrictedTo(req.body?.restrictedTo);
    if (isInvalid(restrictedResult)) { errorResponse(res, restrictedResult.error, 400); return; }

    const now = new Date();
    const page = new ConfluencePage({
      parentId: parent ? parent._id : null,
      path: parent ? [...(parent.path || []), parent._id] : [],
      isTemplate,
      labels: labelsResult.value,
      createdBy: access.userId,
      updatedBy: access.userId,
      restrictedTo: restrictedResult.value
    });
    const pageId = String(page._id);

    if (isTemplate || publish) {
      page.title = encryptField(titleResult.value, pageId) as string;
      page.content = (encryptField(contentResult.value, pageId) as string) || '';
      page.status = 'published';
      page.hasDraft = false;
      if (publish) {
        page.publishedAt = now;
        page.publishedBy = access.userId as unknown as mongoose.Types.ObjectId;
        // First publication = version 1. Nothing to archive yet.
        page.currentVersion = 1;
      }
    } else {
      page.title = '';
      page.content = '';
      page.draftTitle = encryptField(titleResult.value, pageId) as string;
      page.draftContent = (encryptField(contentResult.value, pageId) as string) || '';
      page.hasDraft = true;
      page.status = 'draft';
    }

    await page.save();

    const saved = page.toObject() as AnyDoc;
    await activityFor(saved, access, 'confluence_page_created', {
      status: saved.status,
      isTemplate: !!saved.isTemplate,
      ...(publish ? { version: 1 } : {})
    });
    await recordBlockActivity(saved, access, '', contentResult.value);
    // Published straight away: everyone mentioned in it is "newly" mentioned.
    // Drafts and templates notify nobody — nothing is visible to readers yet.
    if (publish) {
      await notifyMentions(saved, { userId: access.userId, displayName: req.user?.displayName }, extractMentionIdsFromHtml(contentResult.value));
    }

    decryptConfluencePageFields(saved as any);
    const users = await resolveUsers(pageUserIds(saved));
    createdResponse(res, isTemplate ? 'Template created' : publish ? 'Page published' : 'Draft saved', {
      page: toApiPage(saved, access, users, { includeContent: true })
    });
  } catch (error) {
    logger.error('Error in createPage:', error);
    internalServerErrorResponse(res, 'Failed to create page');
  }
};

/** True when the client's last-seen version no longer matches the stored one. */
function isStale(expected: unknown, actual: Date | undefined): boolean {
  if (typeof expected !== 'string' || !expected || !actual) return false;
  const t = new Date(expected).getTime();
  return Number.isFinite(t) && t !== new Date(actual).getTime();
}

const CONFLICT_MESSAGE = 'This page was changed by someone else since you opened it. Reload to see their changes, or save again to overwrite them.';

/** A state-qualified write matched nothing: report a review lock (423) if the page
 *  went into review meanwhile, otherwise the usual concurrent-change conflict (409). */
async function respondWriteConflict(page: AnyDoc, res: Response): Promise<void> {
  const current = (await ConfluencePage.findOne({ _id: page._id }).select('reviewState').lean()) as AnyDoc | null;
  if (current && isInReview({ ...current, isTemplate: page.isTemplate })) {
    errorResponse(res, DRAFT_LOCKED_MESSAGE, 423);
    return;
  }
  errorResponse(res, CONFLICT_MESSAGE, 409);
}

/**
 * PUT /api/confluence/pages/:id/draft
 * body: { title, content, expectedUpdatedAt?, force? }
 *
 * Saves the working copy. Readers keep seeing the published version until the
 * page is published. For a template this saves the template itself.
 */
export const saveDraft = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!canEditPage(access, page)) { errorResponse(res, 'You do not have permission to edit this page', 403); return; }
    // 423, not 409: the client's 409 handler offers "overwrite", which must never
    // apply to a review lock (force does not bypass it either).
    if (isDraftLocked(page)) { errorResponse(res, DRAFT_LOCKED_MESSAGE, 423); return; }

    const titleResult = validatePageTitle(req.body?.title, CONFLUENCE_MAX_TITLE_LENGTH);
    if (isInvalid(titleResult)) { errorResponse(res, titleResult.error, 400); return; }
    const contentResult = validateContent(req.body?.content);
    if (isInvalid(contentResult)) { errorResponse(res, contentResult.error, 400); return; }

    const force = req.body?.force === true;
    if (!force && isStale(req.body?.expectedUpdatedAt, page.updatedAt)) {
      errorResponse(res, CONFLICT_MESSAGE, 409);
      return;
    }

    const pageId = String(page._id);
    const set: AnyDoc = { updatedBy: access.userId };
    if (page.isTemplate) {
      set.title = encryptField(titleResult.value, pageId);
      set.content = encryptField(contentResult.value, pageId) || '';
    } else {
      set.draftTitle = encryptField(titleResult.value, pageId);
      set.draftContent = encryptField(contentResult.value, pageId) || '';
      set.hasDraft = true;
    }

    // State-qualified write: if someone else saved in between, fail cleanly. The
    // review lock is part of the filter even when forced.
    const filter: AnyDoc = { _id: page._id, isDeleted: false, reviewState: null };
    if (!force) filter.updatedAt = page.updatedAt;
    const updated = (await ConfluencePage.findOneAndUpdate(filter, { $set: set }, { new: true }).lean()) as AnyDoc | null;
    if (!updated) { await respondWriteConflict(page, res); return; }

    // A draft save is only visible to draft-capable users; a template save is public.
    // A save that only edited existing blocks (whiteboard / structured table) is
    // recorded as just that (coalesced like draft saves — recording "draft saved"
    // too would interleave and defeat the coalescing); one that added, cleared or
    // removed a block, or changed table columns, gets both entries.
    const previousBody = decryptField(page.isTemplate || !page.hasDraft ? page.content : page.draftContent, pageId);
    const changes = blockChanges(previousBody, contentResult.value);
    if (changes.length === 0 || changes.some((c) => !BLOCK_EDIT_ACTIONS.has(c.action))) {
      await activityFor(updated, access, page.isTemplate ? 'confluence_page_edited' : 'confluence_draft_saved', undefined, !page.isTemplate);
    }
    for (const change of changes) await activityFor(updated, access, change.action, change.details, !page.isTemplate);
    signalPageChanged(req, updated, 'draft_saved');

    decryptConfluencePageFields(updated as any);
    const users = await resolveUsers(pageUserIds(updated));
    successResponse(res, page.isTemplate ? 'Template saved' : 'Draft saved', {
      page: toApiPage(updated, access, users, { includeContent: true })
    });
  } catch (error) {
    logger.error('Error in saveDraft:', error);
    internalServerErrorResponse(res, 'Failed to save draft');
  }
};

/* ---------------------------------------------------------------------------
   Versioned publishing
   --------------------------------------------------------------------------- */

function isDuplicateKeyError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: number }).code === 11000;
}

/**
 * Copies the page's CURRENT published version into ConfluencePageVersion before it
 * is replaced. `page` must already be decrypted (title/content in plaintext); the
 * copy is re-encrypted under the version document's own id.
 *
 * A duplicate (pageId, version) means this exact outgoing version was already
 * archived — by a concurrent publish, or by an earlier attempt whose page update
 * then lost a race. A published version's content never changes, so the existing
 * row is identical and is simply kept.
 */
async function archiveCurrentVersion(page: AnyDoc, versionNumber: number): Promise<void> {
  const row = new ConfluencePageVersion({
    pageId: page._id,
    version: versionNumber,
    labels: Array.isArray(page.labels) ? page.labels : [],
    createdBy: page.publishedBy || page.updatedBy || page.createdBy,
    publishedAt: page.publishedAt || page.updatedAt || new Date(),
    restoredFromVersion: page.restoredFromVersion || undefined
  });
  const versionId = String(row._id);
  row.title = encryptField(page.title || 'Untitled', versionId) as string;
  row.content = (encryptField(page.content || '', versionId) as string) || '';
  try {
    await row.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) return;
    throw error;
  }
}

interface PublishOptions {
  title: string;
  content: string;
  /** Set when this publish restores an older version. */
  restoredFromVersion?: number;
  /** Keep any unpublished draft (restore) rather than clearing it (normal publish). */
  keepDraft: boolean;
  /** Optimistic-concurrency token for the editor's Publish; omitted when forced. */
  expectedUpdatedAt?: Date;
  /** Ends the draft's review cycle (any publish that replaces the draft). Restore
   *  keeps the draft — and so its review — and passes false. */
  clearReview?: boolean;
  /** Extra state the page must still be in (e.g. reviewState: 'in_review' for approval). */
  extraFilter?: AnyDoc;
  /** Extra fields written atomically with the publish (e.g. who approved it). */
  extraSet?: AnyDoc;
}

/** Every review-workflow field on ConfluencePage. */
const REVIEW_FIELDS = ['reviewState', 'reviewSubmittedBy', 'reviewSubmittedAt', 'lastReviewOutcome', 'lastReviewedBy', 'lastReviewedAt', 'reviewNote'];

/**
 * Publishes `title`/`content` as the page's NEXT version: archives the current
 * published version (if any), then writes the new one. The page update is guarded
 * on the version number the caller read, so two concurrent publishes can never
 * both claim the same number — the loser gets null (→ 409) and history stays
 * intact. `page` must already be decrypted. Returns the updated, still-encrypted
 * lean page, or null on a concurrent change.
 */
async function publishNextVersion(page: AnyDoc, access: ConfluenceAccess, opts: PublishOptions): Promise<AnyDoc | null> {
  const current = currentVersionOf(page);
  if (current >= 1) await archiveCurrentVersion(page, current);

  const pageId = String(page._id);
  // `null` matches a missing field: never-published pages, and pages published
  // before version history existed (those count as version 1).
  const filter: AnyDoc = { _id: page._id, isDeleted: false, currentVersion: page.currentVersion ?? null, ...(opts.extraFilter || {}) };
  if (opts.expectedUpdatedAt) filter.updatedAt = opts.expectedUpdatedAt;

  const set: AnyDoc = {
    title: encryptField(opts.title, pageId),
    content: encryptField(opts.content, pageId) || '',
    status: 'published',
    publishedAt: new Date(),
    publishedBy: access.userId,
    updatedBy: access.userId,
    currentVersion: current + 1
  };
  const unset: AnyDoc = {};
  if (opts.restoredFromVersion) set.restoredFromVersion = opts.restoredFromVersion;
  else unset.restoredFromVersion = 1;
  if (!opts.keepDraft) {
    set.hasDraft = false;
    unset.draftTitle = 1;
    unset.draftContent = 1;
  }
  if (opts.clearReview) REVIEW_FIELDS.forEach((f) => { unset[f] = 1; });
  // A field can't be both $set and $unset in one update: extraSet wins.
  for (const [key, value] of Object.entries(opts.extraSet || {})) {
    set[key] = value;
    delete unset[key];
  }

  return (await ConfluencePage.findOneAndUpdate(filter, { $set: set, $unset: unset }, { new: true }).lean()) as AnyDoc | null;
}

/**
 * POST /api/confluence/pages/:id/publish
 * body (optional): { title, content, expectedUpdatedAt?, force? }
 *
 * With a body, publishes that title/content directly (the editor's "Publish").
 * Without one, publishes the saved draft.
 */
export const publishPage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (page.isTemplate) { errorResponse(res, 'Templates are not published', 400); return; }
    if (!canPublishPage(access, page)) { errorResponse(res, 'You do not have permission to publish this page', 403); return; }
    // A submitted draft is published only through Approve & Publish, so the review
    // is always recorded and the approved content is exactly what was submitted.
    if (isInReview(page)) { errorResponse(res, 'This page is in review. Use Approve & Publish.', 423); return; }

    const force = req.body?.force === true;
    if (!force && isStale(req.body?.expectedUpdatedAt, page.updatedAt)) {
      errorResponse(res, CONFLICT_MESSAGE, 409);
      return;
    }

    decryptConfluencePageFields(page as any);
    let title: string;
    let content: string;
    if (req.body?.title !== undefined || req.body?.content !== undefined) {
      const titleResult = validatePageTitle(req.body?.title, CONFLUENCE_MAX_TITLE_LENGTH);
      if (isInvalid(titleResult)) { errorResponse(res, titleResult.error, 400); return; }
      const contentResult = validateContent(req.body?.content);
      if (isInvalid(contentResult)) { errorResponse(res, contentResult.error, 400); return; }
      title = titleResult.value;
      content = contentResult.value;
    } else if (page.hasDraft) {
      title = page.draftTitle || 'Untitled';
      content = page.draftContent || '';
    } else {
      errorResponse(res, 'There are no unpublished changes to publish', 400);
      return;
    }

    // Mentions already in the live version were notified when it was published.
    const previouslyMentioned = page.status === 'published' ? extractMentionIdsFromHtml(page.content) : [];
    const previousBody = page.hasDraft ? page.draftContent : page.content;

    // Archives the outgoing published version (if any) and publishes this as the next one.
    const updated = await publishNextVersion(page, access, {
      title,
      content,
      keepDraft: false,
      clearReview: true,
      // Also enforced in the write itself, in case it was submitted meanwhile.
      extraFilter: { reviewState: null },
      expectedUpdatedAt: force ? undefined : page.updatedAt
    });
    if (!updated) { await respondWriteConflict(page, res); return; }

    await recordBlockActivity(updated, access, previousBody, content);
    await activityFor(updated, access, 'confluence_page_published', { version: currentVersionOf(updated) });
    signalPageChanged(req, updated, 'published');
    await notifyMentions(
      updated,
      { userId: access.userId, displayName: req.user?.displayName },
      newlyMentioned(previouslyMentioned, extractMentionIdsFromHtml(content), access.userId)
    );

    decryptConfluencePageFields(updated as any);
    const users = await resolveUsers(pageUserIds(updated));
    successResponse(res, 'Page published', { page: toApiPage(updated, access, users, { includeContent: true }) });
  } catch (error) {
    logger.error('Error in publishPage:', error);
    internalServerErrorResponse(res, 'Failed to publish page');
  }
};

/** DELETE /api/confluence/pages/:id/draft — throws away a published page's unpublished changes. */
export const discardDraft = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!canEditPage(access, page)) { errorResponse(res, 'You do not have permission to edit this page', 403); return; }
    if (page.status !== 'published' || !page.hasDraft) {
      errorResponse(res, 'There is no draft to discard on this page', 400);
      return;
    }
    if (isDraftLocked(page)) { errorResponse(res, DRAFT_LOCKED_MESSAGE, 423); return; }

    // The draft (and with it any earlier review of it) is gone.
    const unset: AnyDoc = { draftTitle: 1, draftContent: 1 };
    REVIEW_FIELDS.forEach((f) => { unset[f] = 1; });
    const updated = (await ConfluencePage.findOneAndUpdate(
      { _id: page._id, isDeleted: false, reviewState: null },
      { $set: { hasDraft: false, updatedBy: access.userId }, $unset: unset },
      { new: true }
    ).lean()) as AnyDoc | null;
    if (!updated) { await respondWriteConflict(page, res); return; }

    await activityFor(updated, access, 'confluence_draft_discarded', undefined, true);
    signalPageChanged(req, updated, 'draft_discarded');

    decryptConfluencePageFields(updated as any);
    const users = await resolveUsers(pageUserIds(updated));
    successResponse(res, 'Draft discarded', { page: toApiPage(updated, access, users, { includeContent: true }) });
  } catch (error) {
    logger.error('Error in discardDraft:', error);
    internalServerErrorResponse(res, 'Failed to discard draft');
  }
};

/** PATCH /api/confluence/pages/:id/labels — body: { labels } */
export const updateLabels = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!canEditPage(access, page)) { errorResponse(res, 'You do not have permission to edit this page', 403); return; }

    const labelsResult = normalizeLabels(req.body?.labels, CONFLUENCE_MAX_LABELS, CONFLUENCE_MAX_LABEL_LENGTH);
    if (isInvalid(labelsResult)) { errorResponse(res, labelsResult.error, 400); return; }

    // Labels are metadata: changing them is not a content edit, so the page's
    // updatedAt (the editor's concurrency token) is deliberately left alone.
    await ConfluencePage.updateOne(
      { _id: page._id, isDeleted: false },
      { $set: { labels: labelsResult.value } },
      { timestamps: false }
    );

    const before = new Set((page.labels || []).map((l: string) => String(l).toLowerCase()));
    const after = new Set(labelsResult.value.map((l) => l.toLowerCase()));
    const added = labelsResult.value.filter((l) => !before.has(l.toLowerCase()));
    const removed = (page.labels || []).filter((l: string) => !after.has(String(l).toLowerCase()));
    if (added.length || removed.length) {
      await activityFor(page, access, 'confluence_labels_changed', { added, removed });
    }

    successResponse(res, 'Labels updated', { labels: labelsResult.value });
  } catch (error) {
    logger.error('Error in updateLabels:', error);
    internalServerErrorResponse(res, 'Failed to update labels');
  }
};

/**
 * PATCH /api/confluence/pages/:id/move — body: { parentId } (null = root)
 * Moves a page and its whole subtree. Refuses to move a page under itself or one
 * of its own descendants, or past the maximum depth.
 */
export const movePage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (page.isTemplate) { errorResponse(res, 'Templates cannot be moved into the page tree', 400); return; }
    if (!canEditPage(access, page)) { errorResponse(res, 'You do not have permission to move this page', 403); return; }

    const parentResult = parseParentId(req.body?.parentId);
    if (parentResult.ok === false) { errorResponse(res, 'Invalid parent page', 400); return; }
    const newParentId = parentResult.value;
    const pageId = String(page._id);

    let newPath: mongoose.Types.ObjectId[] = [];
    if (newParentId) {
      if (newParentId === pageId) { errorResponse(res, 'A page cannot be its own parent', 400); return; }
      const parent = (await ConfluencePage.findOne({ _id: newParentId, isDeleted: false, isTemplate: false }).lean()) as AnyDoc | null;
      if (!parent || !(await isPageVisible(access, parent))) { notFoundResponse(res, 'Parent page not found'); return; }
      if ((parent.path || []).some((p: unknown) => idStr(p) === pageId)) {
        errorResponse(res, 'A page cannot be moved under one of its own child pages', 400);
        return;
      }
      newPath = [...(parent.path || []), parent._id];
    }

    if (idStr(page.parentId) === (newParentId || '')) {
      successResponse(res, 'Page not moved', { parentId: newParentId });
      return;
    }

    const descendants = ((await ConfluencePage.find({ path: page._id, isDeleted: false })
      .select('_id path')
      .lean()) || []) as AnyDoc[];
    const oldDepth = (page.path || []).length;
    const deepestRelative = descendants.reduce((max, d) => Math.max(max, (d.path || []).length - oldDepth), 0);
    if (newPath.length + deepestRelative >= CONFLUENCE_MAX_DEPTH) {
      errorResponse(res, `Pages cannot be nested more than ${CONFLUENCE_MAX_DEPTH} levels deep`, 400);
      return;
    }

    const ops: AnyDoc[] = [
      {
        updateOne: {
          filter: { _id: page._id, isDeleted: false },
          update: { $set: { parentId: newParentId ? new mongoose.Types.ObjectId(newParentId) : null, path: newPath } },
          timestamps: false
        }
      },
      ...descendants.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          // Keep the descendant's chain below this page, re-rooted at the new location.
          update: { $set: { path: [...newPath, page._id, ...(d.path || []).slice(oldDepth + 1)] } },
          timestamps: false
        }
      }))
    ];
    await ConfluencePage.bulkWrite(ops as any);

    // Parent ids only — never the parents' titles, which may be restricted from
    // some of the people who can read this page's activity.
    // Ancestors changed: someone present may no longer be able to see the page.
    signalPageChanged(req, page, null, 'all');
    await activityFor(page, access, 'confluence_page_moved', {
      fromParentId: page.parentId ? String(page.parentId) : null,
      toParentId: newParentId,
      movedCount: descendants.length + 1
    });

    successResponse(res, 'Page moved', { parentId: newParentId, movedCount: descendants.length + 1 });
  } catch (error) {
    logger.error('Error in movePage:', error);
    internalServerErrorResponse(res, 'Failed to move page');
  }
};

/**
 * PATCH /api/confluence/pages/:id/restrictions — body: { restrictedTo: userId[] }
 * Empty list removes the restriction. The owner always keeps access.
 */
export const updateRestrictions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (page.isTemplate) { errorResponse(res, 'Templates cannot be restricted', 400); return; }
    if (!canEditPage(access, page)) { errorResponse(res, 'You do not have permission to change who can view this page', 403); return; }

    const restrictedResult = await validateRestrictedTo(req.body?.restrictedTo);
    if (isInvalid(restrictedResult)) { errorResponse(res, restrictedResult.error, 400); return; }

    // If the editor restricts the page to a list that excludes themselves, they
    // would lock themselves out (unless they own it); keep them on the list.
    const ids = restrictedResult.value;
    if (ids.length > 0 && !access.isSuperAdmin && !isPageOwner(access, page) && !ids.includes(access.userId)) {
      ids.push(access.userId);
    }

    await ConfluencePage.updateOne(
      { _id: page._id, isDeleted: false },
      { $set: { restrictedTo: ids } },
      { timestamps: false }
    );

    signalPageChanged(req, page, null, 'all');
    // Who is on the list is not recorded: only editors may see it (toApiPage).
    await activityFor(page, access, 'confluence_restrictions_changed', { restricted: ids.length > 0 });

    successResponse(res, 'Page restrictions updated', { restrictedTo: ids, isRestricted: ids.length > 0 });
  } catch (error) {
    logger.error('Error in updateRestrictions:', error);
    internalServerErrorResponse(res, 'Failed to update page restrictions');
  }
};

/** POST /api/confluence/pages/:id/favorite — toggles the caller's favourite. */
export const toggleFavorite = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const isFavorite = (page.favoritedBy || []).some((u: unknown) => idStr(u) === access.userId);
    await ConfluencePage.updateOne(
      { _id: page._id },
      isFavorite ? { $pull: { favoritedBy: access.userId } } : { $addToSet: { favoritedBy: access.userId } },
      { timestamps: false }
    );
    await activityFor(page, access, isFavorite ? 'confluence_page_unfavorited' : 'confluence_page_favorited');
    successResponse(res, isFavorite ? 'Removed from favorites' : 'Added to favorites', { isFavorite: !isFavorite });
  } catch (error) {
    logger.error('Error in toggleFavorite:', error);
    internalServerErrorResponse(res, 'Failed to update favorite');
  }
};

/**
 * DELETE /api/confluence/pages/:id — soft-deletes the page and its whole subtree.
 */
export const deletePage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const liveChildren = page.isTemplate ? 0 : await ConfluencePage.countDocuments({ parentId: page._id, isDeleted: false });
    if (!canDeletePage(access, page, liveChildren > 0)) {
      errorResponse(
        res,
        liveChildren > 0 && access.perms.create && isPageOwner(access, page)
          ? 'This page has child pages. Ask someone with delete permission to remove it.'
          : 'You do not have permission to delete this page',
        403
      );
      return;
    }

    const result = await ConfluencePage.updateMany(
      { $or: [{ _id: page._id }, { path: page._id }], isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: access.userId } }
    );
    // Recorded on the deleted page itself; its Activity panel is gone with it (404),
    // so this entry is visible only in the admin Audit Log.
    await activityFor(page, access, 'confluence_page_deleted', { deletedCount: result.modifiedCount });
    signalPageChanged(req, page, 'deleted', 'all');
    successResponse(res, 'Page deleted', { deletedCount: result.modifiedCount });
  } catch (error) {
    logger.error('Error in deletePage:', error);
    internalServerErrorResponse(res, 'Failed to delete page');
  }
};

/* ---------------------------------------------------------------------------
   Version history

   Versions are only ever reached through their page (pageId + version number)
   and only after loadVisiblePage has applied the page's CURRENT access rules
   (restrictions, draft visibility, deletion) — so an old version is never more
   visible than the page itself, and knowing a version's id is useless.
   --------------------------------------------------------------------------- */

/** Author of the page's current published version. */
function currentPublisherOf(page: AnyDoc): unknown {
  return page.publishedBy || page.updatedBy || page.createdBy;
}

/**
 * GET /api/confluence/pages/:id/versions — metadata only (no content is loaded or
 * decrypted). The current version comes from the page itself, superseded ones
 * from ConfluencePageVersion. Any user who can view the page can view its history.
 */
export const listVersions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const current = currentVersionOf(page);
    if (current === 0) {
      successResponse(res, 'Version history retrieved successfully', { currentVersion: 0, versions: [], restoreMode: null });
      return;
    }

    const archived = ((await ConfluencePageVersion.find({ pageId: page._id })
      .select('-content')
      .sort({ version: -1 })
      .lean()) || []) as AnyDoc[];
    const superseded = supersededVersions(archived as (AnyDoc & { version: number })[], current);
    // Content was never loaded, so this only decrypts the (small) titles.
    superseded.forEach((v) => decryptConfluenceVersionFields(v as any));

    const users = await resolveUsers([currentPublisherOf(page), ...superseded.map((v) => v.createdBy)]);
    const pageId = String(page._id);

    const versions = [
      {
        version: current,
        title: decryptField(page.title, pageId) || 'Untitled',
        author: userRef(users, currentPublisherOf(page)),
        publishedAt: page.publishedAt || page.updatedAt || null,
        isCurrent: true,
        restoredFromVersion: page.restoredFromVersion || null
      },
      ...superseded.map((v) => ({
        version: v.version,
        title: v.title || 'Untitled',
        author: userRef(users, v.createdBy),
        publishedAt: v.publishedAt || v.createdAt || null,
        isCurrent: false,
        restoredFromVersion: v.restoredFromVersion || null
      }))
    ];

    successResponse(res, 'Version history retrieved successfully', {
      currentVersion: current,
      versions,
      restoreMode: restoreModeFor(access, page)
    });
  } catch (error) {
    logger.error('Error in listVersions:', error);
    internalServerErrorResponse(res, 'Failed to retrieve version history');
  }
};

/**
 * GET /api/confluence/pages/:id/versions/:version — one version, decrypted, for
 * read-only viewing. Only the requested version is decrypted.
 */
export const getVersion = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const n = parseVersionNumber(req.params.version);
    if (!n) { errorResponse(res, 'Invalid version number', 400); return; }
    const current = currentVersionOf(page);
    if (current === 0 || n > current) { notFoundResponse(res, 'Version not found'); return; }

    const pageId = String(page._id);
    if (n === current) {
      // The live version is the page itself — its PUBLISHED fields, never the draft.
      const users = await resolveUsers([currentPublisherOf(page)]);
      successResponse(res, 'Version retrieved successfully', {
        version: {
          version: n,
          title: decryptField(page.title, pageId) || 'Untitled',
          content: decryptField(page.content, pageId) || '',
          labels: Array.isArray(page.labels) ? page.labels : [],
          author: userRef(users, currentPublisherOf(page)),
          publishedAt: page.publishedAt || page.updatedAt || null,
          isCurrent: true,
          restoredFromVersion: page.restoredFromVersion || null
        }
      });
      return;
    }

    const row = (await ConfluencePageVersion.findOne({ pageId: page._id, version: n }).lean()) as AnyDoc | null;
    if (!row) { notFoundResponse(res, 'Version not found'); return; }
    decryptConfluenceVersionFields(row as any);
    const users = await resolveUsers([row.createdBy]);
    successResponse(res, 'Version retrieved successfully', {
      version: {
        version: row.version,
        title: row.title || 'Untitled',
        content: row.content || '',
        labels: Array.isArray(row.labels) ? row.labels : [],
        author: userRef(users, row.createdBy),
        publishedAt: row.publishedAt || row.createdAt || null,
        isCurrent: false,
        restoredFromVersion: row.restoredFromVersion || null
      }
    });
  } catch (error) {
    logger.error('Error in getVersion:', error);
    internalServerErrorResponse(res, 'Failed to retrieve version');
  }
};

/**
 * POST /api/confluence/pages/:id/versions/:version/restore
 *
 * Never deletes or rewrites history:
 * - edit + publish → the old content is published as a NEW version (current+1),
 *   after the current one is archived. Any unpublished draft is kept.
 * - edit only      → the old content replaces the page's draft; it goes live only
 *   when someone with publish publishes it (which then creates the new version).
 * - view only      → 403.
 */
export const restoreVersion = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const n = parseVersionNumber(req.params.version);
    if (!n) { errorResponse(res, 'Invalid version number', 400); return; }
    const current = currentVersionOf(page);
    if (current === 0) { errorResponse(res, 'This page has no published versions to restore', 400); return; }

    const mode = restoreModeFor(access, page);
    if (!mode) { errorResponse(res, 'You do not have permission to restore versions of this page', 403); return; }
    // Restoring into the draft would change a submitted draft under the reviewer.
    // (A publish-mode restore keeps the draft — and its review — untouched.)
    if (mode === 'draft' && isDraftLocked(page)) { errorResponse(res, DRAFT_LOCKED_MESSAGE, 423); return; }
    if (n === current) { errorResponse(res, `Version ${n} is already the current version`, 400); return; }
    if (n > current) { notFoundResponse(res, 'Version not found'); return; }

    const source = (await ConfluencePageVersion.findOne({ pageId: page._id, version: n }).lean()) as AnyDoc | null;
    if (!source) { notFoundResponse(res, 'Version not found'); return; }
    decryptConfluenceVersionFields(source as any);
    const title = source.title || 'Untitled';
    const content = source.content || '';

    let updated: AnyDoc | null;
    if (mode === 'publish') {
      decryptConfluencePageFields(page as any);
      const previouslyMentioned = extractMentionIdsFromHtml(page.content);
      updated = await publishNextVersion(page, access, { title, content, restoredFromVersion: n, keepDraft: true });
      if (!updated) {
        errorResponse(res, 'This page changed while restoring. Reload it and try again.', 409);
        return;
      }
      await activityFor(updated, access, 'confluence_version_restored', { fromVersion: n, version: currentVersionOf(updated), mode });
      // The restored content is now live: anyone it mentions who the replaced
      // version did not is told, exactly as for a normal publish.
      await notifyMentions(
        updated,
        { userId: access.userId, displayName: req.user?.displayName },
        newlyMentioned(previouslyMentioned, extractMentionIdsFromHtml(content), access.userId)
      );
    } else {
      const pageId = String(page._id);
      updated = (await ConfluencePage.findOneAndUpdate(
        { _id: page._id, isDeleted: false, reviewState: null },
        {
          $set: {
            draftTitle: encryptField(title, pageId),
            draftContent: encryptField(content, pageId) || '',
            hasDraft: true,
            updatedBy: access.userId
          }
        },
        { new: true }
      ).lean()) as AnyDoc | null;
      if (!updated) { await respondWriteConflict(page, res); return; }
      // Lands in the draft, so only draft-capable users see it in the activity feed.
      await activityFor(updated, access, 'confluence_version_restored', { fromVersion: n, mode }, true);
    }

    signalPageChanged(req, updated, 'version_restored');
    decryptConfluencePageFields(updated as any);
    const users = await resolveUsers(pageUserIds(updated));
    successResponse(res, mode === 'publish' ? `Version ${n} restored as version ${currentVersionOf(updated)}` : `Version ${n} restored to the draft`, {
      mode,
      restoredFromVersion: n,
      newVersion: mode === 'publish' ? currentVersionOf(updated) : null,
      page: toApiPage(updated, access, users, { includeContent: true })
    });
  } catch (error) {
    logger.error('Error in restoreVersion:', error);
    internalServerErrorResponse(res, 'Failed to restore version');
  }
};

/* ---------------------------------------------------------------------------
   Review workflow: Draft → In Review → (Approve & Publish | Request Changes)

   Every transition re-validates permissions and state server-side and writes
   with a state-qualified filter, so a manipulated or stale request can't skip a
   step or overwrite someone else's change. Approval publishes through the SAME
   publishNextVersion used by Publish/Restore (Phase 2 version history).
   --------------------------------------------------------------------------- */

const REVIEW_NOTE_MAX_LENGTH = 2000;

/** The reviewer's last-seen version of the page. Required for approve / request
 *  changes so a decision is never applied to content the reviewer didn't see. */
function requireReviewToken(req: AuthenticatedRequest, page: AnyDoc, res: Response): boolean {
  const expected = req.body?.expectedUpdatedAt;
  if (typeof expected !== 'string' || !expected) {
    errorResponse(res, 'expectedUpdatedAt is required — reload the page and try again', 400);
    return false;
  }
  if (isStale(expected, page.updatedAt)) {
    errorResponse(res, 'This page changed since you opened it. Reload it and review the latest version.', 409);
    return false;
  }
  return true;
}

/**
 * Live-presence side effects of a successful write (socket/confluencePresence.ts):
 * a content-free "this page changed" signal to the people present on it, and —
 * when access or the review lock may have changed — a re-check of who may stay.
 * Best effort: never fails the request it follows.
 */
function signalPageChanged(
  req: AuthenticatedRequest,
  page: AnyDoc,
  kind: ConfluencePageChangeKind | null,
  revalidate: 'page' | 'all' | null = null
): void {
  try {
    if (kind) {
      emitConfluencePageChanged(String(page._id), {
        kind,
        updatedAt: page.updatedAt,
        byUserId: String(req.user?._id || ''),
        byName: req.user?.displayName
      });
    }
    if (revalidate) {
      revalidateConfluencePresence(revalidate === 'page' ? [String(page._id)] : undefined)
        .catch((error) => logger.warn('Confluence presence revalidation failed', error));
    }
  } catch (error) {
    logger.warn('Confluence presence signal failed', error);
  }
}

async function respondWithPage(res: Response, message: string, page: AnyDoc, access: ConfluenceAccess) {
  decryptConfluencePageFields(page as any);
  const users = await resolveUsers(pageUserIds(page));
  successResponse(res, message, { page: toApiPage(page, access, users, { includeContent: true }) });
}

/**
 * POST /api/confluence/pages/:id/review/submit — body: { expectedUpdatedAt? }
 * Draft → In Review. Needs the right to edit the page and a pending draft.
 */
export const submitForReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (page.isTemplate) { errorResponse(res, 'Templates do not go through review', 400); return; }
    if (isInReview(page)) { errorResponse(res, 'This page is already in review', 400); return; }
    if (!hasPendingDraft(page)) { errorResponse(res, 'There are no unpublished changes to review', 400); return; }
    if (!canSubmitForReview(access, page)) { errorResponse(res, 'You do not have permission to submit this page for review', 403); return; }
    if (isStale(req.body?.expectedUpdatedAt, page.updatedAt)) { errorResponse(res, CONFLICT_MESSAGE, 409); return; }

    const filter: AnyDoc = { _id: page._id, isDeleted: false, reviewState: null };
    if (typeof req.body?.expectedUpdatedAt === 'string' && req.body.expectedUpdatedAt) filter.updatedAt = page.updatedAt;
    const updated = (await ConfluencePage.findOneAndUpdate(
      filter,
      {
        $set: { reviewState: 'in_review', reviewSubmittedBy: access.userId, reviewSubmittedAt: new Date() },
        // A new submission starts a fresh review: the previous outcome/note no longer applies.
        $unset: { lastReviewOutcome: 1, lastReviewedBy: 1, lastReviewedAt: 1, reviewNote: 1 }
      },
      { new: true }
    ).lean()) as AnyDoc | null;
    if (!updated) { await respondWriteConflict(page, res); return; }

    await activityFor(updated, access, 'confluence_review_submitted', undefined, true);
    // The draft is now locked: nobody present stays listed as an editor.
    signalPageChanged(req, updated, 'review_submitted', 'page');
    await notifyReviewEvent(updated, { userId: access.userId, displayName: req.user?.displayName }, await reviewersFor(updated),
      'confluence_review_requested', (actor, title) => ({
        title: 'Review requested in Confluence',
        message: `${actor} submitted "${title}" for review`
      }));

    await respondWithPage(res, 'Submitted for review', updated, access);
  } catch (error) {
    logger.error('Error in submitForReview:', error);
    internalServerErrorResponse(res, 'Failed to submit for review');
  }
};

/**
 * POST /api/confluence/pages/:id/review/withdraw
 * In Review → Draft, by the person who submitted it (so they can keep editing).
 * Safe by construction: it only ever removes the review lock — nothing is
 * published or approved, and the result must be submitted (and approved) again.
 */
export const withdrawReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!isInReview(page)) { errorResponse(res, 'This page is not in review', 400); return; }
    if (!canWithdrawReview(access, page)) { errorResponse(res, 'Only the person who submitted this review can withdraw it', 403); return; }

    const updated = (await ConfluencePage.findOneAndUpdate(
      { _id: page._id, isDeleted: false, reviewState: 'in_review', reviewSubmittedBy: access.userId },
      { $unset: { reviewState: 1, reviewSubmittedBy: 1, reviewSubmittedAt: 1 } },
      { new: true }
    ).lean()) as AnyDoc | null;
    if (!updated) { errorResponse(res, CONFLICT_MESSAGE, 409); return; }

    await activityFor(updated, access, 'confluence_review_withdrawn', undefined, true);
    signalPageChanged(req, updated, 'review_withdrawn', 'page');
    await respondWithPage(res, 'Review withdrawn', updated, access);
  } catch (error) {
    logger.error('Error in withdrawReview:', error);
    internalServerErrorResponse(res, 'Failed to withdraw review');
  }
};

/**
 * POST /api/confluence/pages/:id/review/approve — body: { expectedUpdatedAt }
 * In Review → Published. Needs publish rights on the page (edit + publish).
 * Publishes the submitted draft as the next version via publishNextVersion: the
 * current version is archived first, so every earlier version stays intact.
 */
export const approveReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!isInReview(page)) { errorResponse(res, 'This page is not in review', 400); return; }
    if (!canReviewPage(access, page)) { errorResponse(res, 'You do not have permission to approve this page', 403); return; }
    if (!requireReviewToken(req, page, res)) return;

    decryptConfluencePageFields(page as any);
    if (!hasPendingDraft(page)) { errorResponse(res, 'There is nothing to approve', 400); return; }
    const title = page.draftTitle || 'Untitled';
    const content = page.draftContent || '';
    const previouslyMentioned = page.status === 'published' ? extractMentionIdsFromHtml(page.content) : [];
    const submitterId = idStr(page.reviewSubmittedBy);

    const updated = await publishNextVersion(page, access, {
      title,
      content,
      keepDraft: false,
      clearReview: true,
      extraFilter: { reviewState: 'in_review' },
      expectedUpdatedAt: page.updatedAt,
      extraSet: { lastReviewOutcome: 'approved', lastReviewedBy: access.userId, lastReviewedAt: new Date() }
    });
    if (!updated) {
      errorResponse(res, 'This page changed since you opened it. Reload it and review the latest version.', 409);
      return;
    }

    const version = currentVersionOf(updated);
    await activityFor(updated, access, 'confluence_review_approved', { version });
    signalPageChanged(req, updated, 'review_approved', 'page');
    await activityFor(updated, access, 'confluence_page_published', { version, via: 'review' });
    const actor = { userId: access.userId, displayName: req.user?.displayName };
    if (submitterId) {
      await notifyReviewEvent(updated, actor, [submitterId], 'confluence_page_approved', (name, t) => ({
        title: 'Page approved in Confluence',
        message: `${name} approved and published "${t}" (version ${version})`
      }));
    }
    await notifyMentions(updated, actor, newlyMentioned(previouslyMentioned, extractMentionIdsFromHtml(content), access.userId));

    await respondWithPage(res, `Approved and published as version ${version}`, updated, access);
  } catch (error) {
    logger.error('Error in approveReview:', error);
    internalServerErrorResponse(res, 'Failed to approve page');
  }
};

/**
 * POST /api/confluence/pages/:id/review/request-changes — body: { expectedUpdatedAt, note? }
 * In Review → Draft. Needs publish rights on the page. The draft and the live
 * version are untouched and NO version is created; the optional note is stored
 * (encrypted) with the draft and shown only to people who may see drafts.
 */
export const requestChanges = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!isInReview(page)) { errorResponse(res, 'This page is not in review', 400); return; }
    if (!canReviewPage(access, page)) { errorResponse(res, 'You do not have permission to review this page', 403); return; }

    const rawNote = req.body?.note;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') { errorResponse(res, 'note must be text', 400); return; }
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (note.length > REVIEW_NOTE_MAX_LENGTH) {
      errorResponse(res, `The note is too long (max ${REVIEW_NOTE_MAX_LENGTH} characters)`, 400);
      return;
    }
    if (!requireReviewToken(req, page, res)) return;

    const set: AnyDoc = { lastReviewOutcome: 'changes_requested', lastReviewedBy: access.userId, lastReviewedAt: new Date() };
    const unset: AnyDoc = { reviewState: 1 };
    if (note) set.reviewNote = encryptField(note, String(page._id));
    else unset.reviewNote = 1;

    const updated = (await ConfluencePage.findOneAndUpdate(
      { _id: page._id, isDeleted: false, reviewState: 'in_review', updatedAt: page.updatedAt },
      { $set: set, $unset: unset },
      { new: true }
    ).lean()) as AnyDoc | null;
    if (!updated) {
      errorResponse(res, 'This page changed since you opened it. Reload it and review the latest version.', 409);
      return;
    }

    await activityFor(updated, access, 'confluence_review_changes_requested', undefined, true);
    signalPageChanged(req, updated, 'changes_requested', 'page');
    const submitterId = idStr(page.reviewSubmittedBy);
    if (submitterId) {
      await notifyReviewEvent(updated, { userId: access.userId, displayName: req.user?.displayName }, [submitterId],
        'confluence_changes_requested', (name, t) => ({
          title: 'Changes requested in Confluence',
          message: `${name} requested changes to "${t}"`
        }));
    }

    await respondWithPage(res, 'Changes requested', updated, access);
  } catch (error) {
    logger.error('Error in requestChanges:', error);
    internalServerErrorResponse(res, 'Failed to request changes');
  }
};

/* ---------------------------------------------------------------------------
   Images
   --------------------------------------------------------------------------- */

/**
 * POST /api/confluence/images — one image for insertion into a page. Re-encoded
 * to WebP (max 1600px) with EXIF orientation applied by the shared compressor.
 * Returns a RELATIVE url; the client resolves it against the API origin.
 */
export const uploadImage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { errorResponse(res, 'No image uploaded', 400); return; }
    await compressUploadedImage(req.file);
    successResponse(res, 'Image uploaded', { url: `${CONFLUENCE_IMAGES_PUBLIC_PREFIX}${req.file.filename}` }, 201);
  } catch (error) {
    logger.error('Error in uploadImage:', error);
    internalServerErrorResponse(res, 'Failed to upload image');
  }
};

/* ---------------------------------------------------------------------------
   Comments
   --------------------------------------------------------------------------- */

function toApiComment(comment: AnyDoc, access: ConfluenceAccess, users: Map<string, UserRef>) {
  const isAuthor = idStr(comment.authorId) === access.userId;
  return {
    _id: String(comment._id),
    pageId: String(comment.pageId),
    content: comment.content,
    author: userRef(users, comment.authorId),
    // Who was @mentioned, so the client can highlight "@Name" in the text.
    mentions: (Array.isArray(comment.mentions) ? comment.mentions : []).map((id: unknown) => userRef(users, id)),
    createdAt: comment.createdAt,
    editedAt: comment.editedAt || null,
    canEdit: isAuthor,
    canDelete: canDeleteComment(access, comment.authorId)
  };
}

/**
 * Resolves the mentions a client attached to a comment. A mention is kept only if
 * "@DisplayName" really appears in the text AND that user can open the page right
 * now — so a comment can never notify (or reference) someone outside the page's
 * audience, and removing the "@Name" text removes the mention.
 */
async function resolveCommentMentions(page: AnyDoc, text: string, raw: unknown): Promise<string[]> {
  const requested = parseMentionInput(raw);
  if (requested.length === 0) return [];
  const allowed = await usersWhoCanOpenPage(page, requested);
  return mentionsPresentInText(text, allowed);
}

/** GET /api/confluence/pages/:id/comments */
export const listComments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    // Drafts have comments too (review discussion); loadVisiblePage has already
    // limited a draft to the people who may see drafts.
    if (page.isTemplate) {
      successResponse(res, 'Comments retrieved successfully', { comments: [] });
      return;
    }

    const rows = ((await ConfluenceComment.find({ pageId: page._id, isDeleted: false })
      .sort({ createdAt: 1 })
      .lean()) || []) as AnyDoc[];
    rows.forEach((c) => decryptConfluenceCommentFields(c as any));
    const users = await resolveUsers(rows.flatMap((c) => [c.authorId, ...(Array.isArray(c.mentions) ? c.mentions : [])]));
    successResponse(res, 'Comments retrieved successfully', {
      comments: rows.map((c) => toApiComment(c, access, users))
    });
  } catch (error) {
    logger.error('Error in listComments:', error);
    internalServerErrorResponse(res, 'Failed to retrieve comments');
  }
};

/** POST /api/confluence/pages/:id/comments — body: { content, mentions?: [{ userId }] } */
export const addComment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;
    if (!canCommentOnPage(access, page)) {
      errorResponse(res, page.isTemplate ? 'Templates cannot be commented on' : 'You do not have permission to comment', 403);
      return;
    }

    const contentResult = validateComment(req.body?.content);
    if (isInvalid(contentResult)) { errorResponse(res, contentResult.error, 400); return; }

    const mentions = await resolveCommentMentions(page, contentResult.value, req.body?.mentions);
    const comment = new ConfluenceComment({ pageId: page._id, authorId: access.userId, mentions });
    const commentId = String(comment._id);
    comment.content = encryptField(contentResult.value, commentId) as string;
    await comment.save();

    await activityFor(page, access, 'confluence_comment_added', { commentId });
    await notifyMentions(
      page,
      { userId: access.userId, displayName: req.user?.displayName },
      newlyMentioned([], mentions, access.userId),
      commentId
    );

    const saved = comment.toObject() as AnyDoc;
    decryptConfluenceCommentFields(saved as any);
    const users = await resolveUsers([saved.authorId, ...mentions]);
    createdResponse(res, 'Comment added', { comment: toApiComment(saved, access, users) });
  } catch (error) {
    logger.error('Error in addComment:', error);
    internalServerErrorResponse(res, 'Failed to add comment');
  }
};

/** Loads a live comment and its page, if the caller can still see the page; otherwise 404. */
async function loadVisibleComment(
  access: ConfluenceAccess,
  id: unknown,
  res: Response
): Promise<{ comment: AnyDoc; page: AnyDoc } | null> {
  if (!isValidId(id)) { errorResponse(res, 'Invalid comment id', 400); return null; }
  const comment = (await ConfluenceComment.findOne({ _id: id, isDeleted: false }).lean()) as AnyDoc | null;
  if (!comment) { notFoundResponse(res, 'Comment not found'); return null; }
  const page = (await ConfluencePage.findOne({ _id: comment.pageId, isDeleted: false }).lean()) as AnyDoc | null;
  if (!page || !(await isPageVisible(access, page))) { notFoundResponse(res, 'Comment not found'); return null; }
  return { comment, page };
}

/** PATCH /api/confluence/comments/:commentId — author only. body: { content, mentions? } */
export const updateComment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const loaded = await loadVisibleComment(access, req.params.commentId, res);
    if (!loaded) return;
    const { comment, page } = loaded;
    if (idStr(comment.authorId) !== access.userId || !(access.isSuperAdmin || access.perms.comment)) {
      errorResponse(res, 'You can only edit your own comments', 403);
      return;
    }

    const contentResult = validateComment(req.body?.content);
    if (isInvalid(contentResult)) { errorResponse(res, contentResult.error, 400); return; }

    const commentId = String(comment._id);
    const previous = (Array.isArray(comment.mentions) ? comment.mentions : []).map((m: unknown) => idStr(m));
    const mentions = await resolveCommentMentions(page, contentResult.value, req.body?.mentions);

    const updated = (await ConfluenceComment.findOneAndUpdate(
      { _id: comment._id, isDeleted: false },
      { $set: { content: encryptField(contentResult.value, commentId), mentions, editedAt: new Date() } },
      { new: true }
    ).lean()) as AnyDoc | null;
    if (!updated) { notFoundResponse(res, 'Comment not found'); return; }

    await activityFor(page, access, 'confluence_comment_edited', { commentId });
    // Only people newly mentioned by this edit are notified.
    await notifyMentions(
      page,
      { userId: access.userId, displayName: req.user?.displayName },
      newlyMentioned(previous, mentions, access.userId),
      commentId
    );

    decryptConfluenceCommentFields(updated as any);
    const users = await resolveUsers([updated.authorId, ...mentions]);
    successResponse(res, 'Comment updated', { comment: toApiComment(updated, access, users) });
  } catch (error) {
    logger.error('Error in updateComment:', error);
    internalServerErrorResponse(res, 'Failed to update comment');
  }
};

/** DELETE /api/confluence/comments/:commentId — author, or `delete` holders. */
export const deleteComment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const loaded = await loadVisibleComment(access, req.params.commentId, res);
    if (!loaded) return;
    const { comment, page } = loaded;
    if (!canDeleteComment(access, comment.authorId)) {
      errorResponse(res, 'You do not have permission to delete this comment', 403);
      return;
    }

    await ConfluenceComment.updateOne(
      { _id: comment._id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: access.userId } }
    );
    await activityFor(page, access, 'confluence_comment_deleted', { commentId: String(comment._id) });
    successResponse(res, 'Comment deleted', { _id: String(comment._id) });
  } catch (error) {
    logger.error('Error in deleteComment:', error);
    internalServerErrorResponse(res, 'Failed to delete comment');
  }
};

/* ---------------------------------------------------------------------------
   Mention search and activity feed
   --------------------------------------------------------------------------- */

const MENTION_RESULT_LIMIT = 8;
const MENTION_CANDIDATE_LIMIT = 50;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/confluence/mentionable-users?q=&pageId=&parentId=
 *
 * Server-side search (never the whole user list) for the @mention picker. Returns
 * only users who can open the page being written:
 * - pageId   — an existing page: the caller must be able to edit or comment on it.
 * - parentId — a new page being created under a parent: the caller needs create,
 *              and results are users who can see that parent (a child inherits it).
 * - neither  — a new top-level page: anyone with Confluence view.
 * The caller themselves is excluded.
 */
export const searchMentionableUsers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 50) : '';
    const pageId = typeof req.query.pageId === 'string' && req.query.pageId ? req.query.pageId : null;
    const parentId = typeof req.query.parentId === 'string' && req.query.parentId ? req.query.parentId : null;

    // The page whose audience bounds the results (a stand-in for a not-yet-created page).
    let audience: AnyDoc;
    if (pageId) {
      const page = await loadVisiblePage(access, pageId, res);
      if (!page) return;
      if (!canEditPage(access, page) && !canCommentOnPage(access, page)) {
        errorResponse(res, 'You do not have permission to mention people on this page', 403);
        return;
      }
      audience = page;
    } else {
      if (!access.isSuperAdmin && !access.perms.create) {
        errorResponse(res, 'You do not have permission to mention people here', 403);
        return;
      }
      if (parentId) {
        const parent = await loadVisiblePage(access, parentId, res);
        if (!parent) return;
        audience = parent;
      } else {
        // A brand-new, unrestricted, published-to-be root page.
        audience = { _id: null, status: 'published', isTemplate: false, restrictedTo: [], path: [] };
      }
    }

    const filter: AnyDoc = {
      isActive: true,
      _id: { $ne: access.userId },
      $or: [{ 'permissions.modules.confluence.view': true }, { role: 'superadmin' }]
    };
    if (q) {
      const pattern = escapeRegex(q);
      filter.$and = [{ $or: [{ displayName: { $regex: pattern, $options: 'i' } }, { email: { $regex: pattern, $options: 'i' } }] }];
    }

    const candidates = ((await User.find(filter)
      .select(USER_ACCESS_FIELDS)
      .sort({ displayName: 1 })
      .limit(MENTION_CANDIDATE_LIMIT)
      .lean()) || []) as AnyDoc[];

    // A not-yet-saved draft is judged as if it were published: what matters is who
    // will be able to read it, not who may see drafts today.
    const judged = { ...audience, status: audience.isTemplate ? audience.status : 'published' };
    const ancestors = audience._id ? await loadAncestorMap(audience) : new Map<string, AnyDoc>();
    const users = candidates
      .filter((u) => canUserOpen(accessForUser(u), judged, ancestors))
      .slice(0, MENTION_RESULT_LIMIT)
      .map((u) => ({ _id: String(u._id), displayName: u.displayName || u.email, email: u.email }));

    successResponse(res, 'Users retrieved successfully', { users });
  } catch (error) {
    logger.error('Error in searchMentionableUsers:', error);
    internalServerErrorResponse(res, 'Failed to search users');
  }
};

const ACTIVITY_PAGE_SIZE = 20;
const ACTIVITY_MAX_PAGE_SIZE = 50;
/** Detail keys returned to the page Activity panel (never titles, never content). */
const ACTIVITY_DETAIL_KEYS = ['version', 'via', 'boards', 'objects', 'tables', 'rows', 'columns', 'columnsAdded', 'columnsRemoved', 'fromVersion', 'mode', 'added', 'removed', 'restricted', 'status', 'isTemplate', 'commentId', 'deletedCount', 'movedCount'];

/**
 * GET /api/confluence/pages/:id/activity?before=<ISO date>&limit=
 *
 * The page's activity, newest first, cursor-paginated. Page access is checked
 * first (loadVisiblePage: 404 for a page the caller can't see). Draft-stage
 * entries are filtered out IN THE QUERY for users who may not see drafts, so
 * pagination stays exact. Only metadata is returned — no titles, no content.
 */
export const listActivity = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await loadAccess(req, res);
    if (!access) return;
    const page = await loadVisiblePage(access, req.params.id, res);
    if (!page) return;

    const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, ACTIVITY_MAX_PAGE_SIZE) : ACTIVITY_PAGE_SIZE;

    const filter: AnyDoc = { entityType: 'confluence_page', entityId: page._id };
    if (!canSeeDrafts(access, page)) filter['metadata.draftOnly'] = { $ne: true };
    if (typeof req.query.before === 'string' && req.query.before) {
      const before = new Date(req.query.before);
      if (Number.isNaN(before.getTime())) { errorResponse(res, 'Invalid cursor', 400); return; }
      filter.createdAt = { $lt: before };
    }

    const rows = ((await AuditLog.find(filter)
      .select('userId action metadata createdAt')
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean()) || []) as AnyDoc[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    const users = await resolveUsers(pageRows.map((r) => r.userId));
    const activities = pageRows.map((r) => {
      const details: AnyDoc = {};
      for (const key of ACTIVITY_DETAIL_KEYS) {
        if (r.metadata && r.metadata[key] !== undefined) details[key] = r.metadata[key];
      }
      return {
        _id: String(r._id),
        action: r.action,
        actor: userRef(users, r.userId),
        createdAt: r.createdAt,
        details
      };
    });

    successResponse(res, 'Activity retrieved successfully', {
      activities,
      nextCursor: hasMore && pageRows.length ? new Date(pageRows[pageRows.length - 1].createdAt).toISOString() : null
    });
  } catch (error) {
    logger.error('Error in listActivity:', error);
    internalServerErrorResponse(res, 'Failed to retrieve activity');
  }
};
