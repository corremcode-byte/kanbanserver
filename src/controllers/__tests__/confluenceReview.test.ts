/**
 * Confluence review workflow — Draft → In Review → Approve & Publish | Request
 * Changes | Withdraw. Behavioural tests against the real controller.
 *
 * Same in-memory-fake approach as confluenceCollaboration.test.ts (the fake block
 * below is that file's, verbatim — this repo keeps fakes per test file). REAL
 * field encryption; the app's single notification entry point (createNotification)
 * is mocked so each test can assert exactly who would be notified.
 *
 * The properties under test are the ones a workflow can get wrong:
 * - no step can be skipped or forged through the API (permissions + state),
 * - approval goes through Phase 2 versioning (one new version, history intact),
 * - request changes / withdraw never create a version,
 * - nobody who can't see drafts learns anything about a review,
 * - concurrent changes are never silently overwritten.
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

const notify = createNotification as jest.Mock;

/* ── Actors ───────────────────────────────────────────────────────────────── */

const actors = {
  // Writes their own drafts (create + owner) — no edit, no publish.
  author: { _id: new ObjectId(), displayName: 'Akhilesh', perms: { view: true, create: true, comment: true } },
  // Edits any page — but cannot publish/approve.
  editor: { _id: new ObjectId(), displayName: 'Esha', perms: { view: true, edit: true, comment: true } },
  // Reviewers: edit + publish.
  reviewer: { _id: new ObjectId(), displayName: 'Priya', perms: { view: true, create: true, edit: true, publish: true, comment: true } },
  reviewer2: { _id: new ObjectId(), displayName: 'Ravi', perms: { view: true, edit: true, publish: true } },
  // Holds publish but NOT edit — must not be able to approve.
  publishOnly: { _id: new ObjectId(), displayName: 'Pooja', perms: { view: true, publish: true } },
  reader: { _id: new ObjectId(), displayName: 'Reader', perms: { view: true, comment: true } },
  // A reviewer who will be outside a page restriction.
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
  notify.mockClear();
  clock += 60 * 60 * 1000;
});

async function call(handler: (req: any, res: any) => Promise<void>, actor: ActorName, params: Row = {}, body: Row = {}) {
  const a = actors[actor];
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handler({ user: { _id: String(a._id), displayName: a.displayName, role: 'member' }, params, body, query: {} }, res);
  return res as { statusCode: number; body: any };
}

const id = (actor: ActorName) => String(actors[actor]._id);
const get = (pageId: string, actor: ActorName) => call(controller.getPage, actor, { id: pageId });
const pageOf = async (pageId: string, actor: ActorName = 'reviewer') => (await get(pageId, actor)).body.data.page;
// What a real HTTP client sends back: the JSON (ISO string) form of updatedAt.
const token = async (pageId: string, actor: ActorName = 'reviewer') => new Date((await pageOf(pageId, actor)).updatedAt).toISOString();

const submit = (pageId: string, actor: ActorName) => call(controller.submitForReview, actor, { id: pageId }, {});
const withdraw = (pageId: string, actor: ActorName) => call(controller.withdrawReview, actor, { id: pageId }, {});
const approve = async (pageId: string, actor: ActorName, expectedUpdatedAt?: string) =>
  call(controller.approveReview, actor, { id: pageId }, { expectedUpdatedAt: expectedUpdatedAt ?? (await token(pageId)) });
const requestChanges = async (pageId: string, actor: ActorName, note?: string) =>
  call(controller.requestChanges, actor, { id: pageId }, { expectedUpdatedAt: await token(pageId), note });

const versions = async (pageId: string) =>
  (await call(controller.listVersions, 'reviewer', { id: pageId })).body.data.versions.map((v: any) => v.version);
const activityActions = async (pageId: string, actor: ActorName = 'reviewer') =>
  (await call(controller.listActivity, actor, { id: pageId })).body.data.activities.map((a: any) => a.action);
const sent = () => notify.mock.calls.map(([arg]) => arg);

/** A never-published draft written by `author`. */
async function authorDraft(title = 'LOS Documentation', content = '<p>draft v1</p>') {
  const res = await call(controller.createPage, 'author', {}, { title, content });
  expect(res.statusCode).toBe(201);
  return res.body.data.page._id as string;
}

/** A page published `n` times by the reviewer, then given pending draft changes by the editor. */
async function publishedWithDraft(n = 1) {
  const created = await call(controller.createPage, 'reviewer', {}, { title: 'CAM Workflow', content: '<p>v1</p>', publish: true });
  const pageId = created.body.data.page._id as string;
  for (let v = 2; v <= n; v++) {
    await call(controller.publishPage, 'reviewer', { id: pageId }, { title: 'CAM Workflow', content: `<p>v${v}</p>` });
  }
  await call(controller.saveDraft, 'editor', { id: pageId }, { title: 'CAM Workflow', content: `<p>v${n + 1} draft</p>` });
  return pageId;
}

/* ── Submit ───────────────────────────────────────────────────────────────── */

describe('submit for review', () => {
  it('moves a draft to in_review and records who submitted it and when', async () => {
    const pageId = await authorDraft();
    expect((await pageOf(pageId, 'author')).workflowStatus).toBe('draft');

    const res = await submit(pageId, 'author');
    expect(res.statusCode).toBe(200);
    const page = res.body.data.page;
    expect(page.workflowStatus).toBe('in_review');
    expect(page.review).toMatchObject({ state: 'in_review', submittedBy: { _id: id('author'), displayName: 'Akhilesh' } });
    expect(page.review.submittedAt).toBeTruthy();
    expect(page.permissions).toMatchObject({ canSubmitReview: false, canWithdrawReview: true, canReview: false });
  });

  it('works for changes to a published page (the live version stays live)', async () => {
    const pageId = await publishedWithDraft();
    expect((await submit(pageId, 'editor')).statusCode).toBe(200);
    const asReader = await pageOf(pageId, 'reader');
    expect(asReader.content).toBe('<p>v1</p>');
  });

  it('requires the right to edit the page', async () => {
    const pageId = await publishedWithDraft();
    expect((await submit(pageId, 'reader')).statusCode).toBe(403);
    expect((await submit(pageId, 'publishOnly')).statusCode).toBe(403);
    // Someone else's draft-only page isn't even visible to a reader.
    expect((await submit(await authorDraft(), 'reader')).statusCode).toBe(404);
  });

  it('needs pending changes and cannot be submitted twice', async () => {
    const created = await call(controller.createPage, 'reviewer', {}, { title: 'Live', content: '<p>x</p>', publish: true });
    expect((await submit(created.body.data.page._id, 'reviewer')).statusCode).toBe(400);

    const pageId = await authorDraft();
    await submit(pageId, 'author');
    expect((await submit(pageId, 'author')).statusCode).toBe(400);
  });

  it('never applies to templates', async () => {
    const tpl = await call(controller.createPage, 'reviewer', {}, { title: 'Tpl', content: '<p>t</p>', isTemplate: true });
    const tplId = tpl.body.data.page._id;
    expect((await submit(tplId, 'reviewer')).statusCode).toBe(400);
    // Templates keep saving directly, as before.
    expect((await call(controller.saveDraft, 'reviewer', { id: tplId }, { title: 'Tpl', content: '<p>t2</p>' })).statusCode).toBe(200);
    expect((await pageOf(tplId)).workflowStatus).toBe('published');
  });

  it('rejects a stale submission', async () => {
    const pageId = await authorDraft();
    const stale = await token(pageId, 'author');
    await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>newer</p>' });
    expect((await call(controller.submitForReview, 'author', { id: pageId }, { expectedUpdatedAt: stale })).statusCode).toBe(409);
  });
});

/* ── The draft is frozen in review ────────────────────────────────────────── */

describe('draft lock while in review', () => {
  it('blocks every way of changing the submitted draft — even forced saves', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');

    expect((await call(controller.saveDraft, 'editor', { id: pageId }, { title: 'X', content: '<p>sneaky</p>' })).statusCode).toBe(423);
    expect((await call(controller.saveDraft, 'editor', { id: pageId }, { title: 'X', content: '<p>sneaky</p>', force: true })).statusCode).toBe(423);
    expect((await call(controller.discardDraft, 'editor', { id: pageId })).statusCode).toBe(423);
    expect((await call(controller.restoreVersion, 'editor', { id: pageId, version: '1' })).statusCode).toBe(423);
    expect((await pageOf(pageId)).draft.content).toBe('<p>v2 draft</p>');
  });

  it('a publisher cannot bypass review with a plain Publish', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    const res = await call(controller.publishPage, 'reviewer', { id: pageId }, {});
    expect(res.statusCode).toBe(423);
    expect(await versions(pageId)).toEqual([1]);
  });

  it('a publish-mode restore keeps the draft and its review untouched', async () => {
    const pageId = await publishedWithDraft(2);
    await submit(pageId, 'editor');
    const res = await call(controller.restoreVersion, 'reviewer', { id: pageId, version: '1' });
    expect(res.statusCode).toBe(200);
    const page = await pageOf(pageId);
    expect(page.workflowStatus).toBe('in_review');
    expect(page.draft.content).toBe('<p>v3 draft</p>');
  });
});

/* ── Who can see the review ───────────────────────────────────────────────── */

describe('review visibility', () => {
  it('a reviewer sees the live version, the pending draft, and the review details', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    const page = await pageOf(pageId, 'reviewer');
    expect(page.content).toBe('<p>v1</p>');
    expect(page.draft.content).toBe('<p>v2 draft</p>');
    expect(page.review).toMatchObject({ state: 'in_review', submittedBy: { displayName: 'Esha' } });
    expect(page.permissions.canReview).toBe(true);
  });

  it('a reader learns nothing about the review or the draft', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    const res = await get(pageId, 'reader');
    const page = res.body.data.page;
    expect(page.workflowStatus).toBe('published');
    expect(page.hasDraft).toBe(false);
    expect(page).not.toHaveProperty('review');
    expect(page).not.toHaveProperty('draft');
    expect(JSON.stringify(res.body)).not.toMatch(/v2 draft|in_review|Esha/);
  });

  it('a never-published page in review stays invisible to readers (404)', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    expect((await get(pageId, 'reader')).statusCode).toBe(404);
    expect((await call(controller.listActivity, 'reader', { id: pageId })).statusCode).toBe(404);
  });

  it('the tree marks pages in review only for people who may see drafts', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    const node = async (actor: ActorName) =>
      (await call(controller.getTree, actor)).body.data.nodes.find((n: any) => n._id === pageId);
    expect((await node('reviewer')).inReview).toBe(true);
    expect((await node('reader')).inReview).toBe(false);
  });
});

/* ── Approve & Publish ────────────────────────────────────────────────────── */

describe('approve & publish', () => {
  it('requires publish AND edit rights — through the API, not just the UI', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    for (const actor of ['editor', 'publishOnly', 'reader', 'author'] as ActorName[]) {
      const res = await call(controller.approveReview, actor, { id: pageId }, { expectedUpdatedAt: await token(pageId) });
      expect([403, 404]).toContain(res.statusCode);
    }
    expect(await versions(pageId)).toEqual([1]);
    expect((await pageOf(pageId)).workflowStatus).toBe('in_review');
  });

  it('publishes the submitted draft as the next version and keeps every earlier version', async () => {
    const pageId = await publishedWithDraft(5); // versions 1..5, draft = "v6 draft"
    await submit(pageId, 'editor');
    const res = await approve(pageId, 'reviewer');
    expect(res.statusCode).toBe(200);
    const page = res.body.data.page;
    expect(page).toMatchObject({ currentVersion: 6, workflowStatus: 'published', content: '<p>v6 draft</p>', hasDraft: false });
    expect(page.publishedBy).toEqual({ _id: id('reviewer'), displayName: 'Priya' });
    expect(page.review).toMatchObject({ state: null, lastOutcome: 'approved', lastReviewedBy: { displayName: 'Priya' } });
    expect(await versions(pageId)).toEqual([6, 5, 4, 3, 2, 1]);
    const v5 = await call(controller.getVersion, 'reviewer', { id: pageId, version: '5' });
    expect(v5.body.data.version.content).toBe('<p>v5</p>');
  });

  it('first approval of a never-published page is version 1', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    const res = await approve(pageId, 'reviewer');
    expect(res.body.data.page).toMatchObject({ status: 'published', currentVersion: 1 });
    expect((await get(pageId, 'reader')).statusCode).toBe(200);
  });

  it('only approves a page that is actually in review', async () => {
    const pageId = await publishedWithDraft();
    expect((await approve(pageId, 'reviewer')).statusCode).toBe(400);
  });

  it('refuses a missing or stale review token (no silent overwrite)', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    const seen = await token(pageId);
    // The author withdraws, changes the draft, and resubmits after the reviewer opened it.
    await withdraw(pageId, 'author');
    await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS Documentation', content: '<p>changed later</p>' });
    await submit(pageId, 'author');

    expect((await call(controller.approveReview, 'reviewer', { id: pageId }, {})).statusCode).toBe(400);
    expect((await approve(pageId, 'reviewer', seen)).statusCode).toBe(409);
    expect((await pageOf(pageId)).status).toBe('draft');
    // With the fresh token, the reviewer approves what they now see.
    expect((await approve(pageId, 'reviewer')).body.data.page.content).toBe('<p>changed later</p>');
  });
});

/* ── Request changes / withdraw ───────────────────────────────────────────── */

describe('request changes', () => {
  it('returns the page to draft, keeps the draft and live version, and creates NO version', async () => {
    const pageId = await publishedWithDraft(5);
    await submit(pageId, 'editor');
    const res = await requestChanges(pageId, 'reviewer', 'Please add the error codes table.');
    expect(res.statusCode).toBe(200);
    const page = res.body.data.page;
    expect(page.workflowStatus).toBe('draft');
    expect(page.currentVersion).toBe(5);
    expect(page.content).toBe('<p>v5</p>');
    expect(page.draft.content).toBe('<p>v6 draft</p>');
    expect(page.review).toMatchObject({ state: null, lastOutcome: 'changes_requested', note: 'Please add the error codes table.', lastReviewedBy: { displayName: 'Priya' } });
    expect(await versions(pageId)).toEqual([5, 4, 3, 2, 1]);
  });

  it('lets the submitter keep editing and resubmit; approval then makes the next version', async () => {
    const pageId = await publishedWithDraft(5);
    await submit(pageId, 'editor');
    await requestChanges(pageId, 'reviewer');
    expect((await call(controller.saveDraft, 'editor', { id: pageId }, { title: 'CAM Workflow', content: '<p>v6 fixed</p>' })).statusCode).toBe(200);
    await submit(pageId, 'editor');
    const res = await approve(pageId, 'reviewer');
    expect(res.body.data.page).toMatchObject({ currentVersion: 6, content: '<p>v6 fixed</p>' });
    expect(await versions(pageId)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('requires publish rights and a page in review', async () => {
    const pageId = await publishedWithDraft();
    expect((await requestChanges(pageId, 'reviewer')).statusCode).toBe(400);
    await submit(pageId, 'editor');
    expect((await requestChanges(pageId, 'editor')).statusCode).toBe(403);
    expect((await requestChanges(pageId, 'publishOnly')).statusCode).toBe(403);
  });

  it('stores the note encrypted and never shows it to readers', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    await requestChanges(pageId, 'reviewer', 'Confidential: fix the pricing');
    expect(mockModels.ConfluencePage.store[0].reviewNote.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify((await get(pageId, 'reader')).body)).not.toContain('pricing');
  });

  it('rejects an overlong note', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    expect((await requestChanges(pageId, 'reviewer', 'x'.repeat(2001))).statusCode).toBe(400);
  });
});

describe('withdraw', () => {
  it('lets the submitter take the draft back without publishing anything', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    const res = await withdraw(pageId, 'author');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.page.workflowStatus).toBe('draft');
    expect(res.body.data.page.status).toBe('draft');
    expect((await call(controller.saveDraft, 'author', { id: pageId }, { title: 'LOS', content: '<p>more</p>' })).statusCode).toBe(200);
  });

  it('is only for the person who submitted it — others cannot pull a review', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    expect((await withdraw(pageId, 'reviewer')).statusCode).toBe(403);
    expect((await withdraw(pageId, 'reader')).statusCode).toBe(403);
    expect((await pageOf(pageId)).workflowStatus).toBe('in_review');
  });
});

/* ── Notifications ────────────────────────────────────────────────────────── */

describe('notifications', () => {
  it('submission notifies the reviewers who can approve this page — nobody else', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    const recipients = sent().map((n) => n.userId).sort();
    expect(recipients).toEqual([id('outsider'), id('reviewer'), id('reviewer2')].sort());
    expect(sent()[0]).toMatchObject({
      type: 'confluence_review_requested',
      metadata: { confluencePageId: pageId, actionBy: id('author'), confluencePageTitle: 'LOS Documentation' }
    });
    expect(sent()[0].message).toBe('Akhilesh submitted "LOS Documentation" for review');
  });

  it('respects page restrictions and never notifies the actor', async () => {
    const pageId = await publishedWithDraft();
    await call(controller.updateRestrictions, 'reviewer', { id: pageId }, { restrictedTo: [id('editor'), id('reviewer2')] });
    notify.mockClear();
    await submit(pageId, 'reviewer'); // the reviewer submits themselves
    // Not the actor (reviewer), not the outsider (restricted out).
    expect(sent().map((n) => n.userId)).toEqual([id('reviewer2')]);
  });

  it('approval notifies the submitter; request changes notifies the submitter', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    notify.mockClear();
    await requestChanges(pageId, 'reviewer', 'tweak it');
    expect(sent()).toEqual([expect.objectContaining({ userId: id('author'), type: 'confluence_changes_requested' })]);

    await submit(pageId, 'author');
    notify.mockClear();
    await approve(pageId, 'reviewer');
    expect(sent()).toEqual([expect.objectContaining({ userId: id('author'), type: 'confluence_page_approved' })]);
    expect(sent()[0].message).toBe('Priya approved and published "LOS Documentation" (version 1)');
  });

  it('a reviewer approving their own submission gets no self-notification', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'reviewer');
    notify.mockClear();
    await approve(pageId, 'reviewer2');
    expect(sent().map((n) => n.userId)).toEqual([id('reviewer')]);
    notify.mockClear();

    const pageId2 = await publishedWithDraft();
    await submit(pageId2, 'reviewer');
    notify.mockClear();
    await approve(pageId2, 'reviewer');
    expect(sent()).toEqual([]);
  });
});

/* ── Activity / audit ─────────────────────────────────────────────────────── */

describe('activity', () => {
  it('records submit, changes requested, withdraw, approval and the publish', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    await requestChanges(pageId, 'reviewer');
    await submit(pageId, 'author');
    await withdraw(pageId, 'author');
    await submit(pageId, 'author');
    await approve(pageId, 'reviewer');

    expect((await activityActions(pageId)).slice(0, 7)).toEqual([
      'confluence_page_published',
      'confluence_review_approved',
      'confluence_review_submitted',
      'confluence_review_withdrawn',
      'confluence_review_submitted',
      'confluence_review_changes_requested',
      'confluence_review_submitted'
    ]);
    const published = (await call(controller.listActivity, 'reviewer', { id: pageId })).body.data.activities[0];
    expect(published.details).toEqual({ version: 1, via: 'review' });
  });

  it('readers only see the outcome (approval + publish), never the draft-stage review steps', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    await requestChanges(pageId, 'reviewer');
    await submit(pageId, 'editor');
    await approve(pageId, 'reviewer');
    const forReader = await activityActions(pageId, 'reader');
    expect(forReader).not.toContain('confluence_review_submitted');
    expect(forReader).not.toContain('confluence_review_changes_requested');
    expect(forReader).toEqual(expect.arrayContaining(['confluence_review_approved', 'confluence_page_published']));
  });

  it('stores no page content or review note in audit entries', async () => {
    const pageId = await publishedWithDraft();
    await submit(pageId, 'editor');
    await requestChanges(pageId, 'reviewer', 'secret note');
    const serialized = JSON.stringify(mockModels.AuditLog.store);
    expect(serialized).not.toMatch(/secret note|v2 draft/);
  });
});

/* ── Comments & mentions during review ────────────────────────────────────── */

describe('comments during review', () => {
  it('reviewers can comment on a never-published page in review, with mentions', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    notify.mockClear();
    const res = await call(controller.addComment, 'reviewer', { id: pageId }, {
      content: '@Akhilesh please add an overview',
      mentions: [{ userId: id('author') }]
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.data.comment.mentions).toEqual([{ _id: id('author'), displayName: 'Akhilesh' }]);
    expect(sent()).toEqual([expect.objectContaining({ userId: id('author'), type: 'confluence_mention' })]);
    // The draft — and its comments — stay invisible to readers.
    expect((await call(controller.listComments, 'reader', { id: pageId })).statusCode).toBe(404);
  });

  it('a mention of someone who cannot see the draft does not notify them', async () => {
    const pageId = await authorDraft();
    await submit(pageId, 'author');
    notify.mockClear();
    await call(controller.addComment, 'reviewer', { id: pageId }, { content: '@Reader fyi', mentions: [{ userId: id('reader') }] });
    expect(sent()).toEqual([]);
  });
});
