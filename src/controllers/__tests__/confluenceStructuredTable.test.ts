/**
 * Confluence structured tables (Phase 5C) — behavioural tests against the real
 * controller. A structured table is a typed block inside the page body (like a
 * whiteboard), so these tests check it rides on the existing machinery:
 * drafts, review lock, Phase 2 versions/restore, draft visibility,
 * restrictions, search, presence and metadata-only activity.
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
import { extractStructuredTables } from '../../utils/confluenceStructuredTable';

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
const versionOf = async (pageId: string, n: number, actor: ActorName = 'reviewer') =>
  call(controller.getVersion, actor, { id: pageId, version: String(n) });
const search = async (actor: ActorName, q: string) => (await call(controller.searchPages, actor, {}, {}, { q })).body.data.results;
const activity = async (pageId: string, actor: ActorName = 'reviewer') =>
  (await call(controller.listActivity, actor, { id: pageId })).body.data.activities;

/* ── Tables ───────────────────────────────────────────────────────────────── */

const STATUS = {
  id: 'status', name: 'Status', type: 'select',
  options: [{ id: 'progress', label: 'In Progress', color: 'blue' }, { id: 'testing', label: 'Testing', color: 'yellow' }, { id: 'done', label: 'Completed', color: 'green' }]
};
const COLUMNS = [
  { id: 'project', name: 'Project', type: 'text' },
  { id: 'owner', name: 'Owner', type: 'text' },
  STATUS,
  { id: 'deadline', name: 'Deadline', type: 'date' }
];
const tracker = (status = 'progress', extra: Row = {}) => ({
  v: 1,
  title: 'Project Tracker',
  columns: COLUMNS,
  rows: [
    { id: 'r1', cells: { project: 'LOS', owner: 'Vicky', status, deadline: '2026-10-10' } },
    { id: 'r2', cells: { project: 'CAM', owner: 'Priya', status: 'testing', deadline: '2026-10-15' } }
  ],
  ...extra
});

const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const body = (table: unknown) =>
  `<p>Normal documentation</p><div data-type="structured-table" data-table="${attr(table)}"></div><p>More documentation</p>`;
/** The first table in some HTML (normalized), or undefined. */
const tableIn = (html: string | undefined) => extractStructuredTables(html)[0];
const statusOf = (html: string | undefined, rowId = 'r1') => tableIn(html)?.rows.find((r) => r.id === rowId)?.cells.status;

const saveDraft = (pageId: string, actor: ActorName, content: string, extra: Row = {}) =>
  call(controller.saveDraft, actor, { id: pageId }, { title: 'Projects', content, ...extra });

/** Published v1 (reviewer) with LOS = In Progress. */
async function publishedTracker() {
  const res = await call(controller.createPage, 'reviewer', {}, { title: 'Projects', content: body(tracker()), publish: true });
  expect(res.statusCode).toBe(201);
  return res.body.data.page._id as string;
}

/* ── Data / draft ─────────────────────────────────────────────────────────── */

describe('structured table data', () => {
  it('is stored as typed JSON inside the encrypted page body, between normal text', async () => {
    const res = await call(controller.createPage, 'author', {}, { title: 'Projects', content: body(tracker()) });
    expect(res.statusCode).toBe(201);
    const content = (await pageOf(res.body.data.page._id, 'author')).content;
    expect(content).toMatch(/^<p>Normal documentation<\/p><div data-type="structured-table"/);
    expect(content).toMatch(/<p>More documentation<\/p>$/);
    expect(tableIn(content)).toEqual(tracker());
    const stored = mockModels.ConfluencePage.store[0].draftContent;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toMatch(/Vicky|LOS/);
  });

  it('never stores malformed or forged data as sent (invalid select value, unknown type, forged ids)', async () => {
    const pageId = await publishedTracker();
    const forged = {
      ...tracker('shipped'), // not an option
      columns: [...COLUMNS, { id: 'f', name: 'Formula', type: 'formula' }, { id: 'project', name: 'Dup', type: 'text' }],
      rows: [
        { id: 'r1', cells: { project: '<img src=x onerror=alert(1)>', status: 'shipped', deadline: '2026-02-31', f: '=1+1' } },
        { id: 'r1', cells: { project: 'duplicate row id' } },
        { id: 'bad id!', cells: {} }
      ]
    };
    expect((await saveDraft(pageId, 'editor', body(forged))).statusCode).toBe(200);
    const draft = (await pageOf(pageId, 'editor')).draft.content;
    const table = tableIn(draft)!;
    expect(table.columns.map((c) => c.id)).toEqual(['project', 'owner', 'status', 'deadline']);
    expect(table.rows).toEqual([{ id: 'r1', cells: { project: '<img src=x onerror=alert(1)>' } }]);
    expect(draft).not.toMatch(/<img|=1\+1|shipped/);
  });

  it('table edits are draft changes: readers keep the published table and no version is created', async () => {
    const pageId = await publishedTracker();
    for (const s of ['testing', 'done', 'progress', 'done']) {
      expect((await saveDraft(pageId, 'editor', body(tracker(s)))).statusCode).toBe(200);
    }
    expect(await versions(pageId)).toEqual([1]);
    expect(statusOf((await pageOf(pageId, 'editor')).draft.content)).toBe('done');
    const asReader = await get(pageId, 'reader');
    expect(statusOf(asReader.body.data.page.content)).toBe('progress');
    expect(asReader.body.data.page).not.toHaveProperty('draft');
  });
});

/* ── Permissions ──────────────────────────────────────────────────────────── */

describe('permissions', () => {
  it('view-only users cannot modify the table through the API; editors can', async () => {
    const pageId = await publishedTracker();
    expect((await saveDraft(pageId, 'reader', body(tracker('done')))).statusCode).toBe(403);
    expect((await saveDraft(pageId, 'publishOnly', body(tracker('done')))).statusCode).toBe(403);
    expect((await call(controller.publishPage, 'reader', { id: pageId }, { title: 'x', content: body(tracker('done')) })).statusCode).toBe(403);
    expect(statusOf((await pageOf(pageId)).content)).toBe('progress');
    expect((await saveDraft(pageId, 'editor', body(tracker('done')))).statusCode).toBe(200);
  });

  it('a draft-only table is invisible to readers — page, search, everything', async () => {
    const res = await call(controller.createPage, 'author', {}, { title: 'Hidden', content: body(tracker('progress', { title: 'Zebra register' })) });
    const pageId = res.body.data.page._id;
    expect((await get(pageId, 'reader')).statusCode).toBe(404);
    expect(await search('reader', 'Zebra')).toEqual([]);
    expect((await search('author', 'Zebra')).map((r: any) => r._id)).toEqual([pageId]);
  });

  it('restricted pages (and children of restricted pages) protect their tables and versions', async () => {
    const parentId = await publishedTracker();
    const child = await call(controller.createPage, 'reviewer', {}, {
      title: 'Child', content: body(tracker('progress', { title: 'Kiwi tracker' })), parentId, publish: true
    });
    const childId = child.body.data.page._id;
    await call(controller.updateRestrictions, 'reviewer', { id: parentId }, { restrictedTo: [id('editor')] });
    for (const pageId of [parentId, childId]) {
      expect((await get(pageId, 'outsider')).statusCode).toBe(404);
      expect((await versionOf(pageId, 1, 'outsider')).statusCode).toBe(404);
      expect((await saveDraft(pageId, 'outsider', body(tracker('done')))).statusCode).toBe(404);
    }
    expect(await search('outsider', 'Kiwi')).toEqual([]);
    expect(await search('editor', 'Kiwi')).toHaveLength(1);
  });
});

/* ── Review lock ──────────────────────────────────────────────────────────── */

describe('review workflow', () => {
  it('423 locks the table while in review; Request Changes unlocks it', async () => {
    const pageId = await publishedTracker();
    await saveDraft(pageId, 'editor', body(tracker('testing')));
    await call(controller.submitForReview, 'editor', { id: pageId }, {});

    expect((await saveDraft(pageId, 'editor', body(tracker('done')))).statusCode).toBe(423);
    expect((await saveDraft(pageId, 'reviewer', body(tracker('done')), { force: true })).statusCode).toBe(423);
    expect(statusOf((await pageOf(pageId)).draft.content)).toBe('testing');

    await call(controller.requestChanges, 'reviewer', { id: pageId }, { expectedUpdatedAt: await token(pageId) });
    expect((await saveDraft(pageId, 'editor', body(tracker('done')))).statusCode).toBe(200);
  });

  it('Approve & Publish publishes the reviewed table as exactly one version', async () => {
    const pageId = await publishedTracker();
    await saveDraft(pageId, 'editor', body(tracker('done')));
    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    expect((await call(controller.approveReview, 'reviewer', { id: pageId }, { expectedUpdatedAt: await token(pageId) })).statusCode).toBe(200);
    expect(await versions(pageId)).toEqual([2, 1]);
    expect(statusOf((await pageOf(pageId, 'reader')).content)).toBe('done');
  });
});

/* ── Versions / restore ───────────────────────────────────────────────────── */

describe('version history and restore', () => {
  /** v1: In Progress, v2: Completed, v3: Testing. */
  async function threeVersions() {
    const pageId = await publishedTracker();
    for (const s of ['done', 'testing']) {
      await saveDraft(pageId, 'editor', body(tracker(s)));
      expect((await call(controller.publishPage, 'reviewer', { id: pageId }, {})).statusCode).toBe(200);
    }
    expect(await versions(pageId)).toEqual([3, 2, 1]);
    return pageId;
  }

  it('each version keeps its table exactly as it was', async () => {
    const pageId = await threeVersions();
    expect(statusOf((await versionOf(pageId, 1)).body.data.version.content)).toBe('progress');
    expect(statusOf((await versionOf(pageId, 2)).body.data.version.content)).toBe('done');
    expect(tableIn((await versionOf(pageId, 1)).body.data.version.content)).toEqual(tracker('progress'));
    // Archived versions are encrypted at rest.
    expect(JSON.stringify(mockModels.ConfluencePageVersion.store)).not.toMatch(/Vicky/);
  });

  it('a publisher restoring v1 gets v4 = v1\'s table; v2 and v3 stay', async () => {
    const pageId = await threeVersions();
    const res = await call(controller.restoreVersion, 'reviewer', { id: pageId, version: '1' });
    expect(res.body.data).toMatchObject({ mode: 'publish', newVersion: 4 });
    expect(await versions(pageId)).toEqual([4, 3, 2, 1]);
    expect(statusOf((await pageOf(pageId, 'reader')).content)).toBe('progress');
    expect(statusOf((await versionOf(pageId, 3)).body.data.version.content)).toBe('testing');
  });

  it('an editor (no publish) restores into the draft only', async () => {
    const pageId = await threeVersions();
    const res = await call(controller.restoreVersion, 'editor', { id: pageId, version: '2' });
    expect(res.body.data.mode).toBe('draft');
    expect(statusOf((await pageOf(pageId, 'editor')).draft.content)).toBe('done');
    expect(statusOf((await pageOf(pageId, 'reader')).content)).toBe('testing');
    expect(await versions(pageId)).toEqual([3, 2, 1]);
  });

  it('versions are read-only: there is no way to write to an archived version', async () => {
    const pageId = await threeVersions();
    const v1Before = JSON.stringify(mockModels.ConfluencePageVersion.store.find((v: Row) => v.version === 1));
    await saveDraft(pageId, 'editor', body(tracker('testing')));
    await call(controller.restoreVersion, 'reviewer', { id: pageId, version: '1' });
    expect(JSON.stringify(mockModels.ConfluencePageVersion.store.find((v: Row) => v.version === 1))).toBe(v1Before);
  });
});

/* ── Search ───────────────────────────────────────────────────────────────── */

describe('search', () => {
  it('finds a published page by values in its structured table', async () => {
    const pageId = await publishedTracker();
    for (const q of ['LOS', 'Vicky', 'Testing']) {
      expect((await search('reader', q)).map((r: any) => r._id)).toEqual([pageId]);
    }
  });

  it('readers never find a value that only exists in the draft table', async () => {
    const pageId = await publishedTracker();
    await saveDraft(pageId, 'editor', body({ ...tracker(), rows: [{ id: 'r9', cells: { project: 'Quokka' } }] }));
    expect(await search('reader', 'Quokka')).toEqual([]);
    expect((await search('editor', 'Quokka')).map((r: any) => r._id)).toEqual([pageId]);
  });
});

/* ── Activity ─────────────────────────────────────────────────────────────── */

describe('activity', () => {
  it('records added / edited (coalesced) / columns changed / cleared / removed — never contents', async () => {
    const created = await call(controller.createPage, 'author', {}, { title: 'Projects', content: '<p>intro</p>' });
    const pageId = created.body.data.page._id;
    const save = (content: string) => saveDraft(pageId, 'author', content);

    await save(body(tracker()));
    await save(body(tracker('testing')));
    await save(body(tracker('done'))); // coalesced with the previous edit
    await save(body({ ...tracker('done'), columns: COLUMNS.slice(0, 3) }));
    await save(body({ ...tracker('done'), columns: COLUMNS.slice(0, 3), rows: [] }));
    await save('<p>intro</p>');

    const tableActs = (await activity(pageId, 'author')).filter((a: any) => a.action.startsWith('confluence_table_'));
    expect(tableActs.map((a: any) => a.action)).toEqual([
      'confluence_table_removed',
      'confluence_table_cleared',
      'confluence_table_columns_changed',
      'confluence_table_edited',
      'confluence_table_added'
    ]);
    expect(tableActs.find((a: any) => a.action === 'confluence_table_columns_changed').details)
      .toEqual({ tables: 1, rows: 2, columns: 3, columnsAdded: 0, columnsRemoved: 1 });
    expect(JSON.stringify(mockModels.AuditLog.store)).not.toMatch(/Vicky|LOS|Project Tracker|In Progress/);
  });

  it('draft-stage table activity is hidden from readers', async () => {
    const pageId = await publishedTracker();
    await saveDraft(pageId, 'editor', body(tracker('done')));
    const forReader = (await activity(pageId, 'reader')).map((a: any) => a.action);
    expect(forReader).toContain('confluence_table_added');
    expect(forReader).not.toContain('confluence_table_edited');
  });
});

/* ── Presence / delete ────────────────────────────────────────────────────── */

describe('presence and delete', () => {
  it('presence on a page with a structured table works exactly as before', async () => {
    const pageId = await publishedTracker();
    expect(await checkPresenceAccess(id('editor'), pageId)).toEqual({ ok: true, displayName: 'Esha', canEdit: true });
    expect(await checkPresenceAccess(id('reader'), pageId)).toEqual({ ok: false });
    await saveDraft(pageId, 'editor', body(tracker('done')));
    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    expect(await checkPresenceAccess(id('editor'), pageId)).toMatchObject({ ok: true, canEdit: false });
  });

  it('page deletion rules are unchanged and take the table with the page', async () => {
    const pageId = await publishedTracker();
    expect((await call(controller.deletePage, 'editor', { id: pageId })).statusCode).toBe(403);
    const draft = await call(controller.createPage, 'author', {}, { title: 'Scratch', content: body(tracker()) });
    const draftId = draft.body.data.page._id;
    expect((await call(controller.deletePage, 'author', { id: draftId })).statusCode).toBe(200);
    expect((await get(draftId, 'author')).statusCode).toBe(404);
    expect(await search('author', 'Vicky')).toHaveLength(1); // only the published page is left
  });
});
