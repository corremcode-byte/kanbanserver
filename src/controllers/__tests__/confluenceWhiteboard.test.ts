/**
 * Confluence whiteboards (Phase 5B) — behavioural tests against the real
 * controller. A whiteboard is a structured block inside the page body, so these
 * tests check that it rides on the existing machinery rather than around it:
 * drafts, review lock, Phase 2 versions/restore, draft visibility, restrictions,
 * presence and metadata-only activity.
 *
 * Same in-memory-fake approach as the other Confluence suites (the fake block
 * below is confluenceReview.test.ts's, verbatim — fakes stay per test file),
 * with REAL sanitising and field encryption.
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
import { checkPresenceAccess } from '../../socket/confluencePresence';
import { extractWhiteboards } from '../../utils/confluenceWhiteboard';

/* ── Actors ───────────────────────────────────────────────────────────────── */

const actors = {
  author: { _id: new ObjectId(), displayName: 'Akhilesh', perms: { view: true, create: true, comment: true } },
  editor: { _id: new ObjectId(), displayName: 'Esha', perms: { view: true, edit: true, comment: true } },
  reviewer: { _id: new ObjectId(), displayName: 'Priya', perms: { view: true, create: true, edit: true, publish: true, comment: true } },
  publishOnly: { _id: new ObjectId(), displayName: 'Pooja', perms: { view: true, publish: true } },
  reader: { _id: new ObjectId(), displayName: 'Reader', perms: { view: true, comment: true } },
  outsider: { _id: new ObjectId(), displayName: 'Omar', perms: { view: true, edit: true, publish: true } }
};
type ActorName = keyof typeof actors;

beforeAll(() => {
  for (const a of Object.values(actors)) {
    mockModels.User.store.push({
      _id: a._id,
      displayName: a.displayName,
      email: `${a.displayName.toLowerCase()}@mail.com`,
      role: 'member',
      isActive: true,
      permissions: { modules: { confluence: a.perms } }
    });
  }
});

beforeEach(() => {
  for (const key of ['ConfluencePage', 'ConfluencePageVersion', 'ConfluencePageView', 'ConfluenceComment', 'AuditLog'] as const) {
    mockModels[key].store.length = 0;
  }
  clock += 60 * 60 * 1000;
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
const get = (pageId: string, actor: ActorName) => call(controller.getPage, actor, { id: pageId });
const pageOf = async (pageId: string, actor: ActorName = 'reviewer') => (await get(pageId, actor)).body.data.page;
const token = async (pageId: string) => new Date((await pageOf(pageId)).updatedAt).toISOString();
const versions = async (pageId: string) =>
  (await call(controller.listVersions, 'reviewer', { id: pageId })).body.data.versions.map((v: any) => v.version);
const versionContent = async (pageId: string, n: number, actor: ActorName = 'reviewer') =>
  call(controller.getVersion, actor, { id: pageId, version: String(n) });
const actions = async (pageId: string, actor: ActorName = 'reviewer') =>
  (await call(controller.listActivity, actor, { id: pageId })).body.data.activities;

/* ── Boards ───────────────────────────────────────────────────────────────── */

const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const shape = (id: string, text: string, x = 0) => ({ id, type: 'rect', x, y: 0, w: 160, h: 80, text });
const boardOf = (...labels: string[]) => ({
  v: 1,
  h: 480,
  items: [
    ...labels.map((l, i) => shape(`s${i}`, l, i * 200)),
    ...labels.slice(1).map((_, i) => ({ id: `c${i}`, type: 'arrow', from: { id: `s${i}` }, to: { id: `s${i + 1}` } }))
  ]
});
const body = (board: unknown, before = '<p>LOS process</p>') =>
  `${before}<div data-type="whiteboard" data-board="${attr(board)}"></div><p>Notes after the board</p>`;
/** Labels of the first board in some HTML ([] when there is none). */
const labelsIn = (html: string | undefined) =>
  (extractWhiteboards(html)[0]?.items || []).filter((i: any) => 'text' in i).map((i: any) => i.text);

const saveDraft = (pageId: string, actor: ActorName, content: string, extra: Row = {}) =>
  call(controller.saveDraft, actor, { id: pageId }, { title: 'LOS Process', content, ...extra });

/** Published v1 (reviewer) whose board says Alpha → Beta. */
async function publishedWithBoard() {
  const res = await call(controller.createPage, 'reviewer', {}, { title: 'LOS Process', content: body(boardOf('Alpha', 'Beta')), publish: true });
  expect(res.statusCode).toBe(201);
  return res.body.data.page._id as string;
}

/* ── Create / save ────────────────────────────────────────────────────────── */

describe('creating and saving whiteboards', () => {
  it('a page can hold rich text AND a structured whiteboard, stored encrypted', async () => {
    const res = await call(controller.createPage, 'author', {}, { title: 'LOS Process', content: body(boardOf('Start', 'Approved?')) });
    expect(res.statusCode).toBe(201);
    const pageId = res.body.data.page._id;
    // A never-published page's working copy is its `content` (there is no live version yet).
    const draft = (await pageOf(pageId, 'author')).content;
    expect(draft).toMatch(/^<p>LOS process<\/p><div data-type="whiteboard"/);
    expect(draft).toContain('<p>Notes after the board</p>');
    const [board] = extractWhiteboards(draft);
    expect(board.items).toEqual([
      shape('s0', 'Start'),
      shape('s1', 'Approved?', 200),
      { id: 'c0', type: 'arrow', from: { id: 's0' }, to: { id: 's1' } }
    ]);
    const stored = mockModels.ConfluencePage.store[0];
    expect(stored.draftContent.startsWith('enc:v1:')).toBe(true);
    expect(stored.draftContent).not.toContain('Approved?');
  });

  it('saving a whiteboard change is a draft change — readers keep the published board, no new version', async () => {
    const pageId = await publishedWithBoard();
    for (const label of ['Gamma', 'Delta', 'Epsilon']) {
      expect((await saveDraft(pageId, 'editor', body(boardOf('Alpha', label)))).statusCode).toBe(200);
    }
    expect(await versions(pageId)).toEqual([1]);
    expect(labelsIn((await pageOf(pageId, 'editor')).draft.content)).toEqual(['Alpha', 'Epsilon']);

    const asReader = await get(pageId, 'reader');
    expect(labelsIn(asReader.body.data.page.content)).toEqual(['Alpha', 'Beta']);
    expect(JSON.stringify(asReader.body)).not.toMatch(/Gamma|Delta|Epsilon/);
  });

  it('tampered board data is rebuilt, never stored as sent', async () => {
    const pageId = await publishedWithBoard();
    const evil = {
      v: 1,
      items: [
        { id: 's0', type: 'rect', x: 0, y: 0, w: 100, h: 50, text: '<script>alert(1)</script>', onclick: 'x' },
        { id: 'x', type: 'foreignObject', html: '<iframe>' },
        { id: 'c9', type: 'arrow', from: { id: 's0' }, to: { id: 'nope' } }
      ]
    };
    await saveDraft(pageId, 'editor', body(evil, '<p>x</p><script>bad()</script>'));
    const draft = (await pageOf(pageId, 'editor')).draft.content;
    expect(draft).not.toMatch(/<script|<iframe|onclick|foreignObject|nope/);
    expect(extractWhiteboards(draft)[0].items).toEqual([{ id: 's0', type: 'rect', x: 0, y: 0, w: 100, h: 50, text: '<script>alert(1)</script>' }]);
  });
});

/* ── Permissions / visibility ─────────────────────────────────────────────── */

describe('whiteboard permissions', () => {
  it('only people who may edit the page can save a whiteboard', async () => {
    const pageId = await publishedWithBoard();
    expect((await saveDraft(pageId, 'reader', body(boardOf('Hijack')))).statusCode).toBe(403);
    expect((await saveDraft(pageId, 'publishOnly', body(boardOf('Hijack')))).statusCode).toBe(403);
    expect(labelsIn((await pageOf(pageId)).content)).toEqual(['Alpha', 'Beta']);
  });

  it('a never-published page and its whiteboard are invisible to readers (404)', async () => {
    const res = await call(controller.createPage, 'author', {}, { title: 'Secret', content: body(boardOf('Hidden plan')) });
    const pageId = res.body.data.page._id;
    expect((await get(pageId, 'reader')).statusCode).toBe(404);
    const search = await call(controller.searchPages, 'reader', {}, {}, { q: 'Hidden plan' });
    expect(search.body.data.results).toEqual([]);
    // …while its author finds it by a label on the board.
    const own = await call(controller.searchPages, 'author', {}, {}, { q: 'Hidden plan' });
    expect(own.body.data.results.map((r: any) => r._id)).toEqual([pageId]);
  });

  it('page restrictions hide the board, its versions and its history', async () => {
    const pageId = await publishedWithBoard();
    await call(controller.updateRestrictions, 'reviewer', { id: pageId }, { restrictedTo: [id('editor')] });
    expect((await get(pageId, 'outsider')).statusCode).toBe(404);
    expect((await versionContent(pageId, 1, 'outsider')).statusCode).toBe(404);
    expect((await call(controller.listVersions, 'outsider', { id: pageId })).statusCode).toBe(404);
    expect((await saveDraft(pageId, 'outsider', body(boardOf('x')))).statusCode).toBe(404);
  });

  it('a restriction on a parent page hides a child page\'s board too', async () => {
    const parentId = await publishedWithBoard();
    const child = await call(controller.createPage, 'reviewer', {}, { title: 'Child', content: body(boardOf('Child board')), parentId, publish: true });
    const childId = child.body.data.page._id;
    await call(controller.updateRestrictions, 'reviewer', { id: parentId }, { restrictedTo: [id('editor')] });
    expect((await get(childId, 'outsider')).statusCode).toBe(404);
    expect((await versionContent(childId, 1, 'outsider')).statusCode).toBe(404);
    expect((await call(controller.searchPages, 'outsider', {}, {}, { q: 'Child board' })).body.data.results).toEqual([]);
    expect((await call(controller.searchPages, 'editor', {}, {}, { q: 'Child board' })).body.data.results).toHaveLength(1);
  });

  it('published board labels are searchable for readers (no search changes needed)', async () => {
    await publishedWithBoard();
    const search = await call(controller.searchPages, 'reader', {}, {}, { q: 'Alpha' });
    expect(search.body.data.results.map((r: any) => r.title)).toEqual(['LOS Process']);
  });
});

/* ── Review lock ──────────────────────────────────────────────────────────── */

describe('review lock', () => {
  it('a whiteboard in review cannot be changed — forced or not — until changes are requested', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Alpha', 'Submitted')));
    await call(controller.submitForReview, 'editor', { id: pageId }, {});

    expect((await saveDraft(pageId, 'editor', body(boardOf('Sneaky')))).statusCode).toBe(423);
    expect((await saveDraft(pageId, 'reviewer', body(boardOf('Sneaky')), { force: true })).statusCode).toBe(423);
    expect(labelsIn((await pageOf(pageId)).draft.content)).toEqual(['Alpha', 'Submitted']);

    await call(controller.requestChanges, 'reviewer', { id: pageId }, { expectedUpdatedAt: await token(pageId) });
    expect((await saveDraft(pageId, 'editor', body(boardOf('Alpha', 'Fixed')))).statusCode).toBe(200);
  });

  it('Approve & Publish publishes the submitted whiteboard as exactly one new version', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Alpha', 'Reviewed')));
    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    const res = await call(controller.approveReview, 'reviewer', { id: pageId }, { expectedUpdatedAt: await token(pageId) });
    expect(res.statusCode).toBe(200);
    expect(await versions(pageId)).toEqual([2, 1]);
    expect(labelsIn((await pageOf(pageId, 'reader')).content)).toEqual(['Alpha', 'Reviewed']);
  });
});

/* ── Versions / restore ───────────────────────────────────────────────────── */

describe('version history', () => {
  it('each published version keeps its own whiteboard; old versions open with theirs', async () => {
    const pageId = await publishedWithBoard(); // v1: Alpha → Beta
    await saveDraft(pageId, 'editor', body(boardOf('Alpha', 'Beta', 'Gamma')));
    expect((await call(controller.publishPage, 'reviewer', { id: pageId }, {})).statusCode).toBe(200); // v2
    expect(await versions(pageId)).toEqual([2, 1]);

    const v1 = await versionContent(pageId, 1);
    const v2 = await versionContent(pageId, 2);
    expect(labelsIn(v1.body.data.version.content)).toEqual(['Alpha', 'Beta']);
    expect(labelsIn(v2.body.data.version.content)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // The connectors come back too — the board is fully reconstructable.
    expect(extractWhiteboards(v1.body.data.version.content)[0].items.filter((i) => i.type === 'arrow')).toHaveLength(1);
    // Archived versions are encrypted at rest like the page.
    expect(mockModels.ConfluencePageVersion.store[0].content).not.toContain('Alpha');
  });

  it('a publish-mode restore brings back that version\'s whiteboard as a new version', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Changed')));
    await call(controller.publishPage, 'reviewer', { id: pageId }, {});
    const res = await call(controller.restoreVersion, 'reviewer', { id: pageId, version: '1' });
    expect(res.body.data).toMatchObject({ mode: 'publish', newVersion: 3 });
    expect(labelsIn((await pageOf(pageId, 'reader')).content)).toEqual(['Alpha', 'Beta']);
    expect(await versions(pageId)).toEqual([3, 2, 1]);
  });

  it('an editor\'s restore puts that version\'s whiteboard into the draft only', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Changed')));
    await call(controller.publishPage, 'reviewer', { id: pageId }, {});
    const res = await call(controller.restoreVersion, 'editor', { id: pageId, version: '1' });
    expect(res.body.data.mode).toBe('draft');
    expect(labelsIn((await pageOf(pageId, 'editor')).draft.content)).toEqual(['Alpha', 'Beta']);
    expect(labelsIn((await pageOf(pageId, 'reader')).content)).toEqual(['Changed']);
    expect(await versions(pageId)).toEqual([2, 1]);
  });
});

/* ── Presence ─────────────────────────────────────────────────────────────── */

describe('presence on whiteboard pages', () => {
  it('editors of a whiteboard page can join presence; review locks editing; readers are refused', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Draft board')));
    expect(await checkPresenceAccess(id('editor'), pageId)).toEqual({ ok: true, displayName: 'Esha', canEdit: true });
    expect(await checkPresenceAccess(id('reader'), pageId)).toEqual({ ok: false });
    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    expect(await checkPresenceAccess(id('editor'), pageId)).toMatchObject({ ok: true, canEdit: false });
  });
});

/* ── Activity ─────────────────────────────────────────────────────────────── */

describe('whiteboard activity', () => {
  it('records added / edited (coalesced) / cleared / removed — counts only, never labels', async () => {
    const created = await call(controller.createPage, 'author', {}, { title: 'LOS Process', content: '<p>text only</p>' });
    const pageId = created.body.data.page._id;
    const save = (content: string) => saveDraft(pageId, 'author', content);

    await save(body(boardOf('Confidential A')));
    await save(body(boardOf('Confidential A', 'Confidential B')));
    await save(body(boardOf('Confidential A', 'Confidential C'))); // coalesced with the previous edit
    await save(body({ v: 1, h: 480, items: [] }));
    await save('<p>text only</p>');
    await save('<p>text only, edited</p>'); // no board involved: no whiteboard entry

    const wb = (await actions(pageId, 'author')).filter((a: any) => a.action.startsWith('confluence_whiteboard_'));
    expect(wb.map((a: any) => a.action)).toEqual([
      'confluence_whiteboard_removed',
      'confluence_whiteboard_cleared',
      'confluence_whiteboard_edited',
      'confluence_whiteboard_added'
    ]);
    expect(wb.find((a: any) => a.action === 'confluence_whiteboard_added').details).toEqual({ boards: 1, objects: 1 });
    expect(JSON.stringify(mockModels.AuditLog.store)).not.toMatch(/Confidential/);
  });

  it('draft-stage whiteboard activity is hidden from readers; published boards show their outcome', async () => {
    const pageId = await publishedWithBoard();
    await saveDraft(pageId, 'editor', body(boardOf('Alpha', 'Secret step')));
    const forReader = (await actions(pageId, 'reader')).map((a: any) => a.action);
    expect(forReader).toContain('confluence_whiteboard_added'); // the v1 board, created published
    expect(forReader).not.toContain('confluence_whiteboard_edited');
  });
});

/* ── Delete ───────────────────────────────────────────────────────────────── */

describe('deleting a page with a whiteboard', () => {
  it('follows the existing delete rules and takes the board (and its versions) with it', async () => {
    const pageId = await publishedWithBoard();
    expect((await call(controller.deletePage, 'editor', { id: pageId })).statusCode).toBe(403);
    expect((await get(pageId, 'reader')).statusCode).toBe(200);

    const draft = await call(controller.createPage, 'author', {}, { title: 'Scratch', content: body(boardOf('Temp')) });
    const draftId = draft.body.data.page._id;
    expect((await call(controller.deletePage, 'author', { id: draftId })).statusCode).toBe(200);
    expect((await get(draftId, 'author')).statusCode).toBe(404);
    expect((await versionContent(draftId, 1, 'author')).statusCode).toBe(404);
  });
});
