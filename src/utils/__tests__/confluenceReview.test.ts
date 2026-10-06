import {
  workflowStatusOf,
  isInReview,
  hasPendingDraft,
  canSubmitForReview,
  canReviewPage,
  canWithdrawReview,
  isDraftLocked
} from '../confluenceReview';
import { ConfluenceAccess, normalizeConfluencePerms } from '../confluenceAccess';

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const access = (perms: Record<string, boolean>, superadmin = false): ConfluenceAccess => ({
  userId: ME,
  isSuperAdmin: superadmin,
  perms: normalizeConfluencePerms({ view: true, ...perms })
});
const page = (extra: Record<string, unknown> = {}) => ({ status: 'published', isTemplate: false, createdBy: OTHER, hasDraft: false, ...extra });
const inReview = (extra: Record<string, unknown> = {}) => page({ hasDraft: true, reviewState: 'in_review', reviewSubmittedBy: ME, ...extra });

describe('workflowStatusOf', () => {
  const editor = access({ edit: true });
  it('draft / in_review / published for someone who may see drafts', () => {
    expect(workflowStatusOf(editor, page({ status: 'draft' }))).toBe('draft');
    expect(workflowStatusOf(editor, page({ hasDraft: true }))).toBe('draft');
    expect(workflowStatusOf(editor, inReview())).toBe('in_review');
    expect(workflowStatusOf(editor, page())).toBe('published');
  });
  it('never reveals a pending draft or review to someone who cannot see drafts', () => {
    const reader = access({ comment: true });
    expect(workflowStatusOf(reader, page({ hasDraft: true }))).toBe('published');
    expect(workflowStatusOf(reader, inReview({ reviewSubmittedBy: OTHER }))).toBe('published');
  });
  it('templates are always just published', () => {
    expect(workflowStatusOf(editor, page({ isTemplate: true, reviewState: 'in_review' }))).toBe('published');
  });
});

describe('state helpers', () => {
  it('detects review state and pending drafts; templates never qualify', () => {
    expect(isInReview(inReview())).toBe(true);
    expect(isInReview(inReview({ isTemplate: true }))).toBe(false);
    expect(hasPendingDraft(page({ status: 'draft' }))).toBe(true);
    expect(hasPendingDraft(page({ hasDraft: true }))).toBe(true);
    expect(hasPendingDraft(page())).toBe(false);
    expect(hasPendingDraft(page({ isTemplate: true, status: 'draft' }))).toBe(false);
    expect(isDraftLocked(inReview())).toBe(true);
    expect(isDraftLocked(page({ hasDraft: true }))).toBe(false);
  });
});

describe('canSubmitForReview', () => {
  it('needs edit rights on the page and a pending draft', () => {
    expect(canSubmitForReview(access({ edit: true }), page({ hasDraft: true }))).toBe(true);
    expect(canSubmitForReview(access({ create: true }), page({ status: 'draft', createdBy: ME }))).toBe(true);
    expect(canSubmitForReview(access({ create: true }), page({ status: 'draft' }))).toBe(false); // not the owner
    expect(canSubmitForReview(access({ comment: true, publish: true }), page({ hasDraft: true }))).toBe(false);
    expect(canSubmitForReview(access({ edit: true }), page())).toBe(false); // nothing to review
    expect(canSubmitForReview(access({ edit: true }), inReview())).toBe(false); // already in review
  });
});

describe('canReviewPage (approve / request changes)', () => {
  it('needs edit + publish on a page in review', () => {
    expect(canReviewPage(access({ edit: true, publish: true }), inReview())).toBe(true);
    expect(canReviewPage(access({ edit: true }), inReview())).toBe(false);
    expect(canReviewPage(access({ publish: true }), inReview())).toBe(false);
    expect(canReviewPage(access({ comment: true }), inReview())).toBe(false);
    expect(canReviewPage(access({}, true), inReview())).toBe(true);
    expect(canReviewPage(access({ edit: true, publish: true }), page({ hasDraft: true }))).toBe(false);
  });
});

describe('canWithdrawReview', () => {
  it('only the submitter, while they can still edit', () => {
    expect(canWithdrawReview(access({ edit: true }), inReview())).toBe(true);
    expect(canWithdrawReview(access({ edit: true, publish: true }), inReview({ reviewSubmittedBy: OTHER }))).toBe(false);
    expect(canWithdrawReview(access({ comment: true }), inReview())).toBe(false); // lost edit rights
    expect(canWithdrawReview(access({ edit: true }), page({ hasDraft: true }))).toBe(false); // not in review
  });
});
