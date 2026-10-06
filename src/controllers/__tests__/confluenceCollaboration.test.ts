/**
 * Confluence collaboration — @mentions, mention notifications, and the activity /
 * audit trail. Behavioural tests against the real controller.
 *
 * Same in-memory-fake approach as sharedFilesController.test.ts and
 * confluenceVersions.test.ts: tiny in-memory models, REAL field encryption. The
 * app's single notification entry point (createNotification) is mocked so each
 * test can assert exactly who would be notified, and with what.
 *
 * The fake AuditLog has no logAction(): Confluence activity must be written
 * through its own non-broadcasting path, so any regression to logAction (which
 * broadcasts every entry to every socket) would throw and show up as missing
 * activity here.
 */

import mongoose from 'mongoose';

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));
jest.mock('../../utils/imageCompression', () => ({ compressUploadedImage: jest.fn() }));
jest.mock('../notificationController', () => ({ createNotification: jest.fn(async () => ({})) }));

/* ── Tiny in-memory Mongoose stand-in ─────────────────────────────────────── */

type Row = Record<string, any>;
const ObjectId = mongoose.Types.ObjectId;

let clock = Date.UTC(2026, 9, 5, 9, 0, 0);
const tick = () => new Date(++clock);

// The controller's activity coalescing compares against the real Date.now(), so
// keep the fake clock in step with it.
jest.spyOn(Date, 'now').mockImplementation(() => clock);

function copy<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (v instanceof ObjectId) return v;
  if (Array.isArray(v)) return v.map(copy) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Row = {};
    for (const [k, val] of Object.entries(v as Row)) if (typeof val !== 'function') out[k] = copy(val);
    return out as T;
  }
  return v;
}

const norm = (v: any) => (v instanceof Date ? v.getTime() : v instanceof ObjectId ? String(v) : v);
const getPath = (row: Row, path: string) => path.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), row);
const isOperatorObject = (v: any) =>
  v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof ObjectId) && !Array.isArray(v);

function matchesValue(actual: any, expected: any): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (Array.isArray(actual)) return actual.map((x) => String(norm(x))).includes(String(norm(expected)));
  return String(norm(actual)) === String(norm(expected));
}

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Row[]).some((f) => matches(row, f));
    if (key === '$and') return (expected as Row[]).every((f) => matches(row, f));
    const actual = getPath(row, key);
    if (isOperatorObject(expected)) {
      return Object.entries(expected).every(([op, operand]) => {
        switch (op) {
          case '$in': return (operand as any[]).some((x) => matchesValue(actual, x));
          case '$ne': return !matchesValue(actual, operand);
          case '$lt': return actual != null && norm(actual) < norm(operand);
          case '$regex': return typeof actual === 'string' && new RegExp(String(operand), (expected as Row).$options || '').test(actual);
          case '$options': return true;
          default: throw new Error(`fake model: unsupported operator ${op} on "${key}"`);
        }
      });
    }
    return matchesValue(actual, expected);
  });
}

function project(row: Row, spec?: string): Row {
  if (!spec) return row;
  const fields = spec.split(/\s+/).filter(Boolean);
  if (fields.every((f) => f.startsWith('-'))) {
    const out = { ...row };
    fields.forEach((f) => delete out[f.slice(1)]);
    return out;
  }
  const out: Row = { _id: row._id };
  fields.forEach((f) => {
    const top = f.split('.')[0];
    if (top in row) out[top] = row[top];
  });
  return out;
}

function sortRows(rows: Row[], spec?: Row): Row[] {
  if (!spec) return rows;
  const [[k, dir]] = Object.entries(spec);
  return [...rows].sort((a, b) => {
    const x = norm(getPath(a, k));
    const y = norm(getPath(b, k));
    return (x > y ? 1 : x < y ? -1 : 0) * (dir as number);
  });
}

class FakeQuery {
  private projection?: string;
  private sortSpec?: Row;
  private limitN?: number;
  constructor(private run: () => Row[], private single = false) {}
  select(spec: string) { this.projection = spec; return this; }
  sort(spec: Row) { this.sortSpec = spec; return this; }
  limit(n: number) { this.limitN = n; return this; }
  lean() { return this; }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve()
      .then(() => {
        let rows = sortRows(this.run(), this.sortSpec);
        if (this.single) return rows[0] ? copy(project(rows[0], this.projection)) : null;
        if (this.limitN) rows = rows.slice(0, this.limitN);
        return rows.map((r) => copy(project(r, this.projection)));
      })
      .then(resolve, reject);
  }
}

function applyUpdate(row: Row, update: Row) {
  for (const [k, v] of Object.entries(update.$set || {})) row[k] = copy(v);
  for (const k of Object.keys(update.$unset || {})) delete row[k];
  for (const [k, v] of Object.entries(update.$addToSet || {})) {
    row[k] = row[k] || [];
    if (!row[k].some((x: any) => String(x) === String(v))) row[k].push(v);
  }
  for (const [k, v] of Object.entries(update.$pull || {})) row[k] = (row[k] || []).filter((x: any) => String(x) !== String(v));
}

function makeModel(defaults: () => Row, uniqueOn?: string[]) {
  const store: Row[] = [];
  function Model(this: Row, doc: Row) {
    Object.assign(this, defaults(), copy(doc));
    if (!this._id) this._id = new ObjectId();
  }
  Model.store = store;
  Model.prototype.save = async function save(this: Row) {
    const plain = copy(this);
    if (uniqueOn && store.some((r) => uniqueOn.every((k) => String(norm(r[k])) === String(norm(plain[k]))))) {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    }
    const now = tick();
    plain.createdAt = plain.createdAt || now;
    plain.updatedAt = now;
    this.createdAt = plain.createdAt;
    this.updatedAt = now;
    store.push(plain);
    return this;
  };
  Model.prototype.toObject = function toObject(this: Row) { return copy(this); };
  Model.find = (filter: Row = {}) => new FakeQuery(() => store.filter((r) => matches(r, filter)));
  Model.findOne = (filter: Row) => new FakeQuery(() => store.filter((r) => matches(r, filter)), true);
  Model.findById = (id: unknown) => Model.findOne({ _id: id });
  Model.countDocuments = async (filter: Row = {}) => store.filter((r) => matches(r, filter)).length;
  Model.findOneAndUpdate = (filter: Row, update: Row) =>
    new FakeQuery(() => {
      const row = store.find((r) => matches(r, filter));
      if (!row) return [];
      applyUpdate(row, update);
      row.updatedAt = tick();
      return [row];
    }, true);
  Model.updateOne = async (filter: Row, update: Row, opts: Row = {}) => {
    const row = store.find((r) => matches(r, filter));
    if (row) {
      applyUpdate(row, update);
      if (opts.timestamps !== false) row.updatedAt = tick();
    }
    return { modifiedCount: row ? 1 : 0 };
  };
  Model.updateMany = async (filter: Row, update: Row) => {
    const rows = store.filter((r) => matches(r, filter));
    rows.forEach((r) => { applyUpdate(r, update); r.updatedAt = tick(); });
    return { modifiedCount: rows.length };
  };
  Model.bulkWrite = async (ops: Row[]) => {
    for (const op of ops) {
      const { filter, update } = op.updateOne;
      const row = store.find((r) => matches(r, filter));
      if (row) applyUpdate(row, update);
    }
    return {};
  };
  return Model as any;
}

const mockModels = {
  ConfluencePage: makeModel((): Row => ({
    title: '', content: '', hasDraft: false, status: 'draft', parentId: null, path: [], isTemplate: false,
    labels: [], favoritedBy: [], restrictedTo: [], isDeleted: false
  })),
  ConfluencePageVersion: makeModel((): Row => ({ labels: [] }), ['pageId', 'version']),
  ConfluencePageView: makeModel((): Row => ({})),
  ConfluenceComment: makeModel((): Row => ({ isDeleted: false, mentions: [] })),
  AuditLog: makeModel((): Row => ({ metadata: {} })),
  User: makeModel((): Row => ({ isActive: true }))
};

jest.mock('../../models', () => mockModels);

import * as controller from '../confluenceController';
import { createNotification } from '../notificationController';
import { decryptConfluenceActivityTitle, CONFLUENCE_ACTIVITY_COALESCE_MS } from '../../services/confluenceActivityService';

const notify = createNotification as jest.Mock;

/* ── Actors ───────────────────────────────────────────────────────────────── */

const ALL = { view: true, create: true, edit: true, comment: true, publish: true, delete: true };
const actors = {
  author: { _id: new ObjectId(), displayName: 'Akhilesh', perms: ALL },
  priya: { _id: new ObjectId(), displayName: 'Priya', perms: { view: true, comment: true } },
  vicky: { _id: new ObjectId(), displayName: 'Vicky', perms: { view: true, edit: true, comment: true } },
  reader: { _id: new ObjectId(), displayName: 'Reader', perms: { view: true } },
  outsider: { _id: new ObjectId(), displayName: 'Outsider', perms: { view: true, comment: true } },
  noModule: { _id: new ObjectId(), displayName: 'Nomodule', perms: { view: false } },
  inactive: { _id: new ObjectId(), displayName: 'Inactivepriyanka', perms: { view: true, comment: true }, isActive: false }
};
type ActorName = keyof typeof actors;

beforeAll(() => {
  for (const a of Object.values(actors)) {
    mockModels.User.store.push({
      _id: a._id,
      displayName: a.displayName,
      email: `${a.displayName.toLowerCase()}@mail.com`,
      role: 'member',
      isActive: (a as { isActive?: boolean }).isActive !== false,
      permissions: { modules: { confluence: a.perms } }
    });
  }
});

beforeEach(() => {
  for (const key of ['ConfluencePage', 'ConfluencePageVersion', 'ConfluencePageView', 'ConfluenceComment', 'AuditLog'] as const) {
    mockModels[key].store.length = 0;
  }
  notify.mockClear();
  clock += CONFLUENCE_ACTIVITY_COALESCE_MS * 2; // no coalescing across tests
});

async function call(handler: (req: any, res: any) => Promise<void>, actor: ActorName, params: Row = {}, body: Row = {}, query: Row = {}) {
  const a = actors[actor];
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handler({ user: { _id: String(a._id), displayName: a.displayName, role: 'member' }, params, body, query }, res);
  return res as { statusCode: number; body: any };
}

const id = (actor: ActorName) => String(actors[actor]._id);
const mentionSpan = (actor: ActorName) =>
  `<span data-type="mention" data-id="${id(actor)}" data-label="${actors[actor].displayName}">@${actors[actor].displayName}</span>`;

async function createPage(body: Row = {}): Promise<string> {
  const res = await call(controller.createPage, 'author', {}, { title: 'LOS Documentation', content: '<p>intro</p>', publish: true, ...body });
  expect(res.statusCode).toBe(201);
  return res.body.data.page._id;
}

const comment = (pageId: string, actor: ActorName, content: string, mentions: ActorName[] = []) =>
  call(controller.addComment, actor, { id: pageId }, { content, mentions: mentions.map((m) => ({ userId: id(m) })) });

const activity = (pageId: string, actor: ActorName = 'author', query: Row = {}) =>
  call(controller.listActivity, actor, { id: pageId }, {}, query);
const actions = (res: any) => res.body.data.activities.map((a: any) => a.action);

const mentionCalls = () => notify.mock.calls.map(([arg]) => arg);

/* ── Mention search ───────────────────────────────────────────────────────── */

describe('mention search', () => {
  it('searches server-side and returns matching users who can open the page', async () => {
    const pageId = await createPage();
    const res = await call(controller.searchMentionableUsers, 'author', {}, {}, { q: 'pri', pageId });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.users.map((u: any) => u.displayName)).toEqual(['Priya']);
    expect(res.body.data.users[0]).toEqual({ _id: id('priya'), displayName: 'Priya', email: 'priya@mail.com' });
  });

  it('never offers the caller, inactive users, or users without Confluence access', async () => {
    const pageId = await createPage();
    const res = await call(controller.searchMentionableUsers, 'author', {}, {}, { q: '', pageId });
    const names = res.body.data.users.map((u: any) => u.displayName);
    expect(names).not.toContain('Akhilesh');
    expect(names).not.toContain('Inactivepriyanka');
    expect(names).not.toContain('Nomodule');
  });

  it('respects page restrictions — people outside the restriction are not offered', async () => {
    const pageId = await createPage();
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    const res = await call(controller.searchMentionableUsers, 'author', {}, {}, { q: '', pageId });
    expect(res.body.data.users.map((u: any) => u.displayName)).toEqual(['Priya']);
  });

  it('a user who cannot open the page gets the same 404 as for the page itself', async () => {
    const pageId = await createPage();
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    const res = await call(controller.searchMentionableUsers, 'outsider', {}, {}, { q: '', pageId });
    expect(res.statusCode).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('a read-only user (no edit, no comment) cannot search', async () => {
    const pageId = await createPage();
    expect((await call(controller.searchMentionableUsers, 'reader', {}, {}, { q: '', pageId })).statusCode).toBe(403);
  });

  it('searching for a brand-new page requires create permission', async () => {
    expect((await call(controller.searchMentionableUsers, 'priya', {}, {}, { q: '' })).statusCode).toBe(403);
    expect((await call(controller.searchMentionableUsers, 'author', {}, {}, { q: 'vic' })).body.data.users.map((u: any) => u.displayName)).toEqual(['Vicky']);
  });

  it('treats regex characters in the query literally', async () => {
    const pageId = await createPage();
    const res = await call(controller.searchMentionableUsers, 'author', {}, {}, { q: '.*', pageId });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.users).toEqual([]);
  });
});

/* ── Mentions in comments ─────────────────────────────────────────────────── */

describe('mentions in comments', () => {
  it('stores the mentioned user ID and notifies them, with page + comment references', async () => {
    const pageId = await createPage();
    const res = await comment(pageId, 'author', '@Priya please review the LOS documentation', ['priya']);
    expect(res.statusCode).toBe(201);
    const commentId = res.body.data.comment._id;
    expect(res.body.data.comment.mentions).toEqual([{ _id: id('priya'), displayName: 'Priya' }]);
    expect(mockModels.ConfluenceComment.store[0].mentions.map(String)).toEqual([id('priya')]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(mentionCalls()[0]).toMatchObject({
      userId: id('priya'),
      type: 'confluence_mention',
      metadata: {
        confluencePageId: pageId,
        confluenceCommentId: commentId,
        confluencePageTitle: 'LOS Documentation',
        actionBy: id('author'),
        actionByName: 'Akhilesh'
      }
    });
    expect(mentionCalls()[0].message).toBe('Akhilesh mentioned you in a comment on "LOS Documentation"');
  });

  it('drops a mention whose "@Name" is not in the text (no silent notifications)', async () => {
    const pageId = await createPage();
    const res = await comment(pageId, 'author', 'Looks good to me', ['priya']);
    expect(res.body.data.comment.mentions).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a self-mention is stored but never notifies the author', async () => {
    const pageId = await createPage();
    await comment(pageId, 'author', '@Akhilesh note to self', ['author']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('mentioning the same person twice notifies them once', async () => {
    const pageId = await createPage();
    await call(controller.addComment, 'author', { id: pageId }, {
      content: '@Priya and again @Priya',
      mentions: [{ userId: id('priya') }, { userId: id('priya') }]
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a restricted page never notifies — or records — someone outside the restriction', async () => {
    const pageId = await createPage();
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    const res = await comment(pageId, 'author', '@Outsider @Priya have a look', ['outsider', 'priya']);
    expect(res.body.data.comment.mentions.map((m: any) => m.displayName)).toEqual(['Priya']);
    expect(mentionCalls().map((n) => n.userId)).toEqual([id('priya')]);
  });

  it('never notifies inactive users or users without Confluence access', async () => {
    const pageId = await createPage();
    await comment(pageId, 'author', '@Inactivepriyanka @Nomodule ping', ['inactive', 'noModule']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('editing a comment notifies only people newly mentioned by the edit', async () => {
    const pageId = await createPage();
    const created = await comment(pageId, 'author', '@Priya first draft', ['priya']);
    notify.mockClear();

    const commentId = created.body.data.comment._id;
    const edit = (content: string, mentions: ActorName[]) =>
      call(controller.updateComment, 'author', { commentId }, { content, mentions: mentions.map((m) => ({ userId: id(m) })) });

    await edit('@Priya first draft, fixed typo', ['priya']);
    expect(notify).not.toHaveBeenCalled();

    const res = await edit('@Priya and @Vicky please check', ['priya', 'vicky']);
    expect(res.body.data.comment.mentions.map((m: any) => m.displayName)).toEqual(['Priya', 'Vicky']);
    expect(mentionCalls().map((n) => n.userId)).toEqual([id('vicky')]);
  });
});

/* ── Mentions in page content ─────────────────────────────────────────────── */

describe('mentions in page content', () => {
  it('notifies people mentioned in a page when it is published', async () => {
    const pageId = await createPage({ content: `<p>Owner: ${mentionSpan('priya')}</p>` });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mentionCalls()[0]).toMatchObject({
      userId: id('priya'),
      type: 'confluence_mention',
      metadata: { confluencePageId: pageId, confluenceCommentId: undefined }
    });
    expect(mentionCalls()[0].message).toBe('Akhilesh mentioned you in "LOS Documentation"');
  });

  it('keeps the mention (with its user ID) in the stored content', async () => {
    const pageId = await createPage({ content: `<p>${mentionSpan('priya')}</p>` });
    const res = await call(controller.getPage, 'priya', { id: pageId });
    expect(res.body.data.page.content).toContain(`data-id="${id('priya')}"`);
    expect(res.body.data.page.content).toContain('data-type="mention"');
  });

  it('draft saves never notify; re-publishing an existing mention does not notify again', async () => {
    const pageId = await createPage({ content: `<p>${mentionSpan('priya')}</p>` });
    notify.mockClear();

    await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS Documentation', content: `<p>${mentionSpan('priya')} ${mentionSpan('vicky')}</p>` });
    expect(notify).not.toHaveBeenCalled();

    await call(controller.publishPage, 'author', { id: pageId }, {});
    expect(mentionCalls().map((n) => n.userId)).toEqual([id('vicky')]);
  });

  it('a draft-only page (never published) notifies nobody', async () => {
    await createPage({ publish: false, content: `<p>${mentionSpan('priya')}</p>` });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a restricted page does not notify people outside the restriction', async () => {
    const pageId = await createPage();
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    await call(controller.publishPage, 'author', { id: pageId }, { title: 'LOS Documentation', content: `<p>${mentionSpan('outsider')} ${mentionSpan('priya')}</p>` });
    expect(mentionCalls().map((n) => n.userId)).toEqual([id('priya')]);
  });

  it('restoring an older version that mentions someone notifies them (it is live again)', async () => {
    const pageId = await createPage({ content: `<p>${mentionSpan('vicky')}</p>` });
    await call(controller.publishPage, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>no mentions</p>' });
    notify.mockClear();
    const res = await call(controller.restoreVersion, 'author', { id: pageId, version: '1' });
    expect(res.body.data.newVersion).toBe(3);
    expect(mentionCalls().map((n) => n.userId)).toEqual([id('vicky')]);
  });
});

/* ── Activity / audit trail ───────────────────────────────────────────────── */

describe('activity trail', () => {
  it('records the page lifecycle: create, draft save, publish, restore', async () => {
    const pageId = await createPage({ publish: false });
    await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>v1</p>' });
    await call(controller.publishPage, 'author', { id: pageId }, {});
    await call(controller.publishPage, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>v2</p>' });
    await call(controller.restoreVersion, 'author', { id: pageId, version: '1' });

    const res = await activity(pageId);
    expect(actions(res)).toEqual([
      'confluence_version_restored',
      'confluence_page_published',
      'confluence_page_published',
      'confluence_draft_saved',
      'confluence_page_created'
    ]);
    const [restored, publishedV2, publishedV1] = res.body.data.activities;
    expect(restored.details).toEqual({ fromVersion: 1, version: 3, mode: 'publish' });
    expect(publishedV2.details).toEqual({ version: 2 });
    expect(publishedV1.details).toEqual({ version: 1 });
    expect(restored.actor).toEqual({ _id: id('author'), displayName: 'Akhilesh' });
  });

  it('records comment add / edit / delete', async () => {
    const pageId = await createPage();
    const created = await comment(pageId, 'priya', 'Looks good');
    const commentId = created.body.data.comment._id;
    await call(controller.updateComment, 'priya', { commentId }, { content: 'Looks great' });
    await call(controller.deleteComment, 'priya', { commentId });

    const res = await activity(pageId);
    expect(actions(res).slice(0, 3)).toEqual(['confluence_comment_deleted', 'confluence_comment_edited', 'confluence_comment_added']);
    expect(res.body.data.activities[2]).toMatchObject({ actor: { displayName: 'Priya' }, details: { commentId } });
  });

  it('records label, move, restriction and favorite changes', async () => {
    const parentId = await createPage({ title: 'Parent' });
    const pageId = await createPage({ title: 'Child' });
    await call(controller.updateLabels, 'author', { id: pageId }, { labels: ['LOS', 'API'] });
    await call(controller.updateLabels, 'author', { id: pageId }, { labels: ['LOS', 'API'] }); // no change: not recorded
    await call(controller.movePage, 'author', { id: pageId }, { parentId });
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    await call(controller.toggleFavorite, 'priya', { id: pageId });
    await call(controller.toggleFavorite, 'priya', { id: pageId });

    const res = await activity(pageId);
    expect(actions(res)).toEqual([
      'confluence_page_unfavorited',
      'confluence_page_favorited',
      'confluence_restrictions_changed',
      'confluence_page_moved',
      'confluence_labels_changed',
      'confluence_page_created'
    ]);
    const byAction = Object.fromEntries(res.body.data.activities.map((a: any) => [a.action, a.details]));
    expect(byAction.confluence_labels_changed).toEqual({ added: ['LOS', 'API'], removed: [] });
    expect(byAction.confluence_restrictions_changed).toEqual({ restricted: true });
    expect(byAction.confluence_page_moved).toEqual({ movedCount: 1 });
  });

  it('records page deletion in the audit trail (the page itself then 404s)', async () => {
    const pageId = await createPage();
    await call(controller.deletePage, 'author', { id: pageId });
    const entry = mockModels.AuditLog.store.find((r: Row) => r.action === 'confluence_page_deleted');
    expect(entry).toBeTruthy();
    expect(String(entry.entityId)).toBe(pageId);
    expect((await activity(pageId)).statusCode).toBe(404);
  });

  it('coalesces repeated draft saves by the same person', async () => {
    const pageId = await createPage({ publish: false });
    for (let i = 0; i < 3; i++) {
      await call(controller.saveDraft, 'author', { id: pageId }, { title: 'T', content: `<p>${i}</p>` });
    }
    expect(actions(await activity(pageId)).filter((a: string) => a === 'confluence_draft_saved')).toHaveLength(1);
  });

  it('stores metadata only: no content, and the title snapshot is encrypted at rest', async () => {
    const pageId = await createPage({ title: 'Secret Plan', content: '<p>secret body</p>' });
    const row = mockModels.AuditLog.store.find((r: Row) => r.action === 'confluence_page_created');
    expect(row.entityType).toBe('confluence_page');
    expect(JSON.stringify(row)).not.toContain('secret body');
    expect(row.metadata.pageTitle.startsWith('enc:v1:')).toBe(true);
    expect(decryptConfluenceActivityTitle(row)).toBe('Secret Plan');
    // The page Activity panel never returns titles or content.
    expect(JSON.stringify((await activity(pageId)).body)).not.toMatch(/Secret|secret|enc:v1:/);
  });

  it('never records a draft title (draft-stage entries carry no title)', async () => {
    await createPage({ publish: false, title: 'Unannounced Product' });
    const row = mockModels.AuditLog.store.find((r: Row) => r.action === 'confluence_page_created');
    expect(row.metadata.draftOnly).toBe(true);
    expect(row.metadata.pageTitle).toBeUndefined();
  });

  it('hides draft-stage activity from users who cannot see drafts', async () => {
    const pageId = await createPage();
    await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>wip</p>' });
    await call(controller.discardDraft, 'author', { id: pageId });

    expect(actions(await activity(pageId, 'vicky'))).toEqual(['confluence_draft_discarded', 'confluence_draft_saved', 'confluence_page_created']);
    expect(actions(await activity(pageId, 'reader'))).toEqual(['confluence_page_created']);
  });

  it('respects page access — outsiders of a restricted page get 404, deleted pages too', async () => {
    const pageId = await createPage();
    await call(controller.updateRestrictions, 'author', { id: pageId }, { restrictedTo: [id('priya')] });
    const res = await activity(pageId, 'outsider');
    expect(res.statusCode).toBe(404);
    expect(res.body.data).toBeUndefined();
    expect((await activity(pageId, 'priya')).statusCode).toBe(200);
  });

  it('paginates with a cursor', async () => {
    const pageId = await createPage();
    for (let i = 0; i < 4; i++) await call(controller.toggleFavorite, 'priya', { id: pageId });
    const first = await activity(pageId, 'author', { limit: '2' });
    expect(first.body.data.activities).toHaveLength(2);
    expect(first.body.data.nextCursor).toBeTruthy();
    const second = await activity(pageId, 'author', { limit: '2', before: first.body.data.nextCursor });
    const third = await activity(pageId, 'author', { limit: '2', before: second.body.data.nextCursor });
    const all = [...first.body.data.activities, ...second.body.data.activities, ...third.body.data.activities];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((a: any) => a._id)).size).toBe(5);
    expect(third.body.data.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const pageId = await createPage();
    expect((await activity(pageId, 'author', { before: 'yesterday-ish' })).statusCode).toBe(400);
  });
});

/* ── Existing comment behaviour stays intact ──────────────────────────────── */

describe('comments still work as before', () => {
  it('add, list, edit and delete', async () => {
    const pageId = await createPage();
    const created = await comment(pageId, 'priya', 'First!');
    expect(created.statusCode).toBe(201);
    const commentId = created.body.data.comment._id;

    let list = await call(controller.listComments, 'reader', { id: pageId });
    expect(list.body.data.comments.map((c: any) => c.content)).toEqual(['First!']);

    expect((await call(controller.updateComment, 'priya', { commentId }, { content: 'Edited' })).body.data.comment.content).toBe('Edited');
    expect((await call(controller.updateComment, 'vicky', { commentId }, { content: 'hijack' })).statusCode).toBe(403);
    expect((await call(controller.deleteComment, 'reader', { commentId })).statusCode).toBe(403);
    expect((await call(controller.deleteComment, 'priya', { commentId })).statusCode).toBe(200);

    list = await call(controller.listComments, 'reader', { id: pageId });
    expect(list.body.data.comments).toEqual([]);
  });

  it('comments without mentions send no notifications', async () => {
    const pageId = await createPage();
    await comment(pageId, 'priya', 'No mentions here');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a reader without comment permission still cannot comment', async () => {
    const pageId = await createPage();
    expect((await comment(pageId, 'reader', 'hi')).statusCode).toBe(403);
  });
});
