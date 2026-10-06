import {
  ConfluenceAccess,
  ConfluencePageLike,
  normalizeConfluencePerms,
  canSeeDrafts,
  passesRestriction,
  isSelfVisible,
  isVisibleWithAncestors,
  canEditPage,
  canPublishPage,
  canDeletePage,
  canCommentOnPage,
  canDeleteComment,
  validatePageTitle,
  normalizeLabels,
  hasAllLabels,
  parseLabelQuery,
  searchTerms,
  buildSnippet
} from '../confluenceAccess';

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD = 'cccccccccccccccccccccccc';

function access(perms: Partial<Record<string, boolean>> = {}, opts: { superadmin?: boolean; userId?: string } = {}): ConfluenceAccess {
  return {
    userId: opts.userId ?? ME,
    isSuperAdmin: !!opts.superadmin,
    perms: normalizeConfluencePerms({ view: true, ...perms })
  };
}

function page(overrides: Partial<ConfluencePageLike> = {}): ConfluencePageLike {
  return { _id: 'p1', status: 'published', isTemplate: false, isDeleted: false, createdBy: OTHER, restrictedTo: [], path: [], ...overrides };
}

describe('normalizeConfluencePerms', () => {
  it('grants only explicit true', () => {
    expect(normalizeConfluencePerms({ view: true, edit: 'true', publish: 1 })).toEqual({
      view: true, create: false, edit: false, comment: false, publish: false, delete: false
    });
  });
  it('treats a missing module as no permissions', () => {
    expect(Object.values(normalizeConfluencePerms(undefined)).every((v) => v === false)).toBe(true);
  });
});

describe('draft visibility', () => {
  const draft = page({ status: 'draft' });

  it('hides a draft from a viewer-only user', () => {
    expect(isSelfVisible(access(), draft)).toBe(false);
  });
  it('hides a draft from a commenter / creator who does not own it', () => {
    expect(isSelfVisible(access({ comment: true, create: true }), draft)).toBe(false);
  });
  it('shows a draft to its owner', () => {
    expect(isSelfVisible(access(), page({ status: 'draft', createdBy: ME }))).toBe(true);
  });
  it('shows a draft to editors, publishers and super admins', () => {
    expect(isSelfVisible(access({ edit: true }), draft)).toBe(true);
    expect(isSelfVisible(access({ publish: true }), draft)).toBe(true);
    expect(isSelfVisible(access({}, { superadmin: true }), draft)).toBe(true);
  });
  it('canSeeDrafts follows the same rule', () => {
    expect(canSeeDrafts(access(), page())).toBe(false);
    expect(canSeeDrafts(access({ edit: true }), page())).toBe(true);
    expect(canSeeDrafts(access(), page({ createdBy: ME }))).toBe(true);
  });
  it('never shows a deleted page', () => {
    expect(isSelfVisible(access({}, { superadmin: true }), page({ isDeleted: true }))).toBe(false);
  });
});

describe('page restrictions', () => {
  it('lets everyone through when the list is empty', () => {
    expect(passesRestriction(access(), page())).toBe(true);
  });
  it('blocks users who are not on the list', () => {
    expect(passesRestriction(access(), page({ restrictedTo: [THIRD] }))).toBe(false);
  });
  it('allows listed users, the owner and super admins', () => {
    expect(passesRestriction(access(), page({ restrictedTo: [ME] }))).toBe(true);
    expect(passesRestriction(access(), page({ restrictedTo: [THIRD], createdBy: ME }))).toBe(true);
    expect(passesRestriction(access({}, { superadmin: true }), page({ restrictedTo: [THIRD] }))).toBe(true);
  });
  it('accepts populated user refs on the list', () => {
    expect(passesRestriction(access(), page({ restrictedTo: [{ _id: ME }] }))).toBe(true);
  });
  it('does not let edit permission bypass a restriction', () => {
    expect(isSelfVisible(access({ edit: true, delete: true }), page({ restrictedTo: [THIRD] }))).toBe(false);
  });
});

describe('visibility is inherited from ancestors', () => {
  const root = page({ _id: 'root', restrictedTo: [THIRD] });
  const child = page({ _id: 'child', path: ['root'] });
  const grandchild = page({ _id: 'gc', path: ['root', 'child'] });
  const byId = new Map<string, ConfluencePageLike>([['root', root], ['child', child], ['gc', grandchild]]);

  it('hides children of a restricted page', () => {
    expect(isVisibleWithAncestors(access(), child, byId)).toBe(false);
    expect(isVisibleWithAncestors(access(), grandchild, byId)).toBe(false);
  });
  it('shows them to someone allowed on the ancestor', () => {
    expect(isVisibleWithAncestors(access({}, { userId: THIRD }), grandchild, byId)).toBe(true);
  });
  it('hides published children of an unpublished parent from readers', () => {
    const draftParent = page({ _id: 'dp', status: 'draft' });
    const kid = page({ _id: 'k', path: ['dp'] });
    const map = new Map<string, ConfluencePageLike>([['dp', draftParent], ['k', kid]]);
    expect(isVisibleWithAncestors(access(), kid, map)).toBe(false);
    expect(isVisibleWithAncestors(access({ publish: true }), kid, map)).toBe(true);
  });
  it('hides a page whose ancestor was deleted (missing from the live set)', () => {
    const orphan = page({ _id: 'o', path: ['gone'] });
    expect(isVisibleWithAncestors(access(), orphan, new Map([['o', orphan]]))).toBe(false);
  });
  it('treats templates as standalone', () => {
    expect(isVisibleWithAncestors(access(), page({ isTemplate: true, path: ['gone'] }), new Map())).toBe(true);
  });
});

describe('edit / publish / delete / comment rules', () => {
  it('lets edit holders edit any page, and creators only their own', () => {
    expect(canEditPage(access({ edit: true }), page())).toBe(true);
    expect(canEditPage(access({ create: true }), page())).toBe(false);
    expect(canEditPage(access({ create: true }), page({ createdBy: ME }))).toBe(true);
    expect(canEditPage(access(), page({ createdBy: ME }))).toBe(false); // owner without create
  });

  it('requires publish AND the right to edit the page', () => {
    expect(canPublishPage(access({ publish: true }), page())).toBe(false); // cannot edit it
    expect(canPublishPage(access({ publish: true, edit: true }), page())).toBe(true);
    expect(canPublishPage(access({ publish: true, create: true }), page({ createdBy: ME }))).toBe(true);
    expect(canPublishPage(access({ create: true }), page({ createdBy: ME }))).toBe(false);
  });

  it('never publishes templates', () => {
    expect(canPublishPage(access({}, { superadmin: true }), page({ isTemplate: true }))).toBe(false);
  });

  it('lets delete holders delete any page, even with children', () => {
    expect(canDeletePage(access({ delete: true }), page(), true)).toBe(true);
  });

  it('lets an owner-creator delete only their own childless draft (or template)', () => {
    const a = access({ create: true });
    expect(canDeletePage(a, page({ createdBy: ME, status: 'draft' }), false)).toBe(true);
    expect(canDeletePage(a, page({ createdBy: ME, status: 'draft' }), true)).toBe(false);
    expect(canDeletePage(a, page({ createdBy: ME, status: 'published' }), false)).toBe(false);
    expect(canDeletePage(a, page({ createdBy: ME, isTemplate: true }), false)).toBe(true);
    expect(canDeletePage(a, page({ status: 'draft' }), false)).toBe(false);
  });

  it('allows comments on published pages and drafts (for review), never templates, for comment holders', () => {
    expect(canCommentOnPage(access({ comment: true }), page())).toBe(true);
    expect(canCommentOnPage(access(), page())).toBe(false);
    // Drafts can be discussed during review; the draft's own visibility rules
    // (owner / edit / publish only) decide who can reach those comments.
    expect(canCommentOnPage(access({ comment: true }), page({ status: 'draft' }))).toBe(true);
    expect(canCommentOnPage(access({ comment: true }), page({ isTemplate: true }))).toBe(false);
  });

  it('lets authors and delete holders delete a comment', () => {
    expect(canDeleteComment(access(), ME)).toBe(true);
    expect(canDeleteComment(access(), OTHER)).toBe(false);
    expect(canDeleteComment(access({ delete: true }), OTHER)).toBe(true);
  });
});

describe('validatePageTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(validatePageTitle('  Login   API ', 255)).toEqual({ ok: true, value: 'Login API' });
  });
  it.each([[undefined], [''], ['   '], [42]])('rejects %p', (raw) => {
    expect(validatePageTitle(raw, 255).ok).toBe(false);
  });
  it('rejects over-long titles', () => {
    expect(validatePageTitle('x'.repeat(256), 255).ok).toBe(false);
  });
});

describe('labels', () => {
  it('normalises, de-duplicates case-insensitively and keeps first spelling', () => {
    expect(normalizeLabels([' HR ', 'hr', 'Policy', '', 'LOS'], 20, 40)).toEqual({ ok: true, value: ['HR', 'Policy', 'LOS'] });
  });
  it('accepts a missing list as empty', () => {
    expect(normalizeLabels(undefined, 20, 40)).toEqual({ ok: true, value: [] });
  });
  it('rejects unsupported characters, non-strings, too many and too long', () => {
    expect(normalizeLabels(['<script>'], 20, 40).ok).toBe(false);
    expect(normalizeLabels([1], 20, 40).ok).toBe(false);
    expect(normalizeLabels(['a', 'b', 'c'], 2, 40).ok).toBe(false);
    expect(normalizeLabels(['x'.repeat(41)], 20, 40).ok).toBe(false);
    expect(normalizeLabels('HR', 20, 40).ok).toBe(false);
  });
  it('accepts non-Latin letters', () => {
    expect(normalizeLabels(['विकास'], 20, 40).ok).toBe(true);
  });
  it('filters by every requested label, case-insensitively', () => {
    expect(hasAllLabels(['Development', 'LOS'], ['los'])).toBe(true);
    expect(hasAllLabels(['Development'], ['los', 'development'])).toBe(false);
    expect(hasAllLabels(undefined, [])).toBe(true);
  });
  it('parses comma-separated and repeated query values', () => {
    expect(parseLabelQuery('HR, Policy,,HR')).toEqual(['HR', 'Policy']);
    expect(parseLabelQuery(['HR', 'CAM'])).toEqual(['HR', 'CAM']);
    expect(parseLabelQuery(undefined)).toEqual([]);
  });
});

describe('search helpers', () => {
  it('splits a query into lower-cased terms', () => {
    expect(searchTerms('  Login  API ')).toEqual(['login', 'api']);
  });
  it('builds a snippet around the first match', () => {
    const text = `${'a '.repeat(200)}the Status API returns ${'b '.repeat(200)}`;
    const snippet = buildSnippet(text, ['status']);
    expect(snippet).toContain('Status API');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
  it('falls back to the start of the text when nothing matches', () => {
    expect(buildSnippet('Short text', ['zzz'])).toBe('Short text');
  });
});
