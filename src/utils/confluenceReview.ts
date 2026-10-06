/**
 * Pure rules for the Confluence review workflow. No I/O.
 *
 *   Draft ──Submit for Review──▶ In Review ──Approve & Publish──▶ Published
 *     ▲                            │
 *     └──Request Changes / Withdraw┘
 *
 * The review state is deliberately SEPARATE from ConfluencePage.status. `status`
 * answers "is there a live version?" ('draft' = never published, 'published' =
 * yes), and a published page can have pending changes (hasDraft) under review
 * while readers keep seeing the live version. Folding 'in_review' into `status`
 * would hide that live version and break versioning/visibility. So the page
 * stores `reviewState` next to `status`, and the three-state workflow the UI
 * shows is derived here (workflowStatusOf).
 *
 * Permissions reuse the existing Confluence flags — there is no reviewer role:
 * - submit   — anyone who may edit the page (edit, or create + owner)
 * - approve / request changes — anyone who may PUBLISH the page (edit + publish)
 * - withdraw — only the person who submitted it (it can never publish anything)
 */

import { ConfluenceAccess, ConfluencePageLike, canEditPage, canPublishPage, canSeeDrafts } from './confluenceAccess';

export type WorkflowStatus = 'draft' | 'in_review' | 'published';

export interface ReviewablePageLike extends ConfluencePageLike {
  hasDraft?: boolean;
  reviewState?: string | null;
  reviewSubmittedBy?: unknown;
}

function idOf(value: unknown): string {
  if (value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)) {
    return String((value as { _id: unknown })._id);
  }
  return value === undefined || value === null ? '' : String(value);
}

export function isInReview(page: ReviewablePageLike): boolean {
  return !page.isTemplate && page.reviewState === 'in_review';
}

/** True when the page has unpublished content that could be reviewed. */
export function hasPendingDraft(page: ReviewablePageLike): boolean {
  if (page.isTemplate) return false;
  return page.status !== 'published' || !!page.hasDraft;
}

/**
 * The workflow state shown to THIS caller. Someone who may not see drafts only
 * ever learns what they can already read — a published page is just
 * 'published' to them, even while a draft of it is under review.
 */
export function workflowStatusOf(access: ConfluenceAccess, page: ReviewablePageLike): WorkflowStatus {
  if (page.isTemplate) return 'published';
  if (!canSeeDrafts(access, page)) return page.status === 'published' ? 'published' : 'draft';
  if (isInReview(page)) return 'in_review';
  return hasPendingDraft(page) ? 'draft' : 'published';
}

export function canSubmitForReview(access: ConfluenceAccess, page: ReviewablePageLike): boolean {
  return !page.isTemplate && !isInReview(page) && hasPendingDraft(page) && canEditPage(access, page);
}

/** Approve & Publish / Request Changes. */
export function canReviewPage(access: ConfluenceAccess, page: ReviewablePageLike): boolean {
  return isInReview(page) && canPublishPage(access, page);
}

export function canWithdrawReview(access: ConfluenceAccess, page: ReviewablePageLike): boolean {
  return isInReview(page) && !!access.userId && idOf(page.reviewSubmittedBy) === access.userId && canEditPage(access, page);
}

/** While in review the draft is frozen, so a reviewer approves exactly what was submitted. */
export function isDraftLocked(page: ReviewablePageLike): boolean {
  return isInReview(page);
}

export const DRAFT_LOCKED_MESSAGE =
  'This page is in review, so its draft is locked. Withdraw the review (or ask the reviewer to request changes) to edit it.';
