import { currentVersionOf, parseVersionNumber, restoreModeFor, supersededVersions } from '../confluenceVersions';
import { ConfluenceAccess, normalizeConfluencePerms } from '../confluenceAccess';

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const access = (perms: Record<string, boolean>, superadmin = false): ConfluenceAccess => ({
  userId: ME,
  isSuperAdmin: superadmin,
  perms: normalizeConfluencePerms({ view: true, ...perms })
});

const published = (extra: Record<string, unknown> = {}) => ({ status: 'published', isTemplate: false, createdBy: OTHER, ...extra });

describe('currentVersionOf', () => {
  it('is 0 for drafts and templates (no history)', () => {
    expect(currentVersionOf({ status: 'draft' })).toBe(0);
    expect(currentVersionOf(published({ isTemplate: true, currentVersion: 4 }))).toBe(0);
  });
  it('reads the stored number', () => {
    expect(currentVersionOf(published({ currentVersion: 7 }))).toBe(7);
  });
  it('treats a page published before version history existed as version 1', () => {
    expect(currentVersionOf(published())).toBe(1);
    expect(currentVersionOf(published({ currentVersion: null }))).toBe(1);
    expect(currentVersionOf(published({ currentVersion: 0 }))).toBe(1);
  });
});

describe('parseVersionNumber', () => {
  it.each([['1', 1], ['42', 42], [3, 3]])('parses %p', (raw, expected) => {
    expect(parseVersionNumber(raw)).toBe(expected);
  });
  it.each(['0', '-1', '1.5', '1e3', 'abc', '', ' 2', '9999999999', undefined, null, {}])('rejects %p', (raw) => {
    expect(parseVersionNumber(raw)).toBeNull();
  });
});

describe('restoreModeFor', () => {
  it('view-only users cannot restore', () => {
    expect(restoreModeFor(access({ comment: true }), published())).toBeNull();
  });
  it('edit without publish restores into the draft', () => {
    expect(restoreModeFor(access({ edit: true }), published())).toBe('draft');
  });
  it('edit + publish restores as a new published version', () => {
    expect(restoreModeFor(access({ edit: true, publish: true }), published())).toBe('publish');
  });
  it('publish alone is not enough — the caller must be able to edit the page', () => {
    expect(restoreModeFor(access({ publish: true }), published())).toBeNull();
  });
  it('an owner with create follows the same rule on their own page', () => {
    expect(restoreModeFor(access({ create: true }), published({ createdBy: ME }))).toBe('draft');
    expect(restoreModeFor(access({ create: true, publish: true }), published({ createdBy: ME }))).toBe('publish');
  });
  it('super admins restore as a new version', () => {
    expect(restoreModeFor(access({}, true), published())).toBe('publish');
  });
  it('nothing to restore on a draft or template', () => {
    expect(restoreModeFor(access({ edit: true, publish: true }), { status: 'draft' })).toBeNull();
    expect(restoreModeFor(access({ edit: true, publish: true }), published({ isTemplate: true }))).toBeNull();
  });
});

describe('supersededVersions', () => {
  it('keeps only versions older than the current one, newest first, without duplicates', () => {
    const rows = [{ version: 1 }, { version: 3 }, { version: 2 }, { version: 2 }, { version: 4 }];
    expect(supersededVersions(rows, 4).map((r) => r.version)).toEqual([3, 2, 1]);
  });
  it('ignores a leftover archive row carrying the current number', () => {
    expect(supersededVersions([{ version: 2 }, { version: 1 }], 2).map((r) => r.version)).toEqual([1]);
  });
  it('ignores malformed numbers', () => {
    expect(supersededVersions([{ version: 0 }, { version: 1.5 }, { version: 1 }], 3).map((r) => r.version)).toEqual([1]);
  });
});
