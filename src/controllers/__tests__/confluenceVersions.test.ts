/**
 * Confluence version history — behavioural tests.
 *
 * Same in-memory-fake approach as sharedFilesController.test.ts: the properties
 * worth protecting are behavioural (publishing archives the previous version,
 * restore never deletes history, an outsider can never read an old version), so
 * the controller runs for real against tiny in-memory models. Field encryption is
 * NOT mocked — the real utility runs, so encryption at rest is checked too.
 *
 * The fake ConfluencePageVersion enforces the real unique (pageId, version) index
 * by throwing a Mongo-style duplicate-key error.
 */

import mongoose from 'mongoose';

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));
jest.mock('../../utils/imageCompression', () => ({ compressUploadedImage: jest.fn() }));

/* ── Tiny in-memory Mongoose stand-in ─────────────────────────────────────── */

type Row = Record<string, any>;
const ObjectId = mongoose.Types.ObjectId;

let clock = Date.UTC(2026, 9, 5, 9, 0, 0);
const tick = () => new Date(++clock);

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

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Row[]).some((f) => matches(row, f));
    const actual = row[key];
    if (expected === null || expected === undefined) return actual === null || actual === undefined;
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof ObjectId) && !Array.isArray(expected)) {
      if ('$in' in expected) return (expected.$in as any[]).map((x) => String(norm(x))).includes(String(norm(actual)));
      throw new Error(`fake model: unsupported operator in "${key}"`);
    }
    if (Array.isArray(actual)) return actual.map((x) => String(norm(x))).includes(String(norm(expected)));
    return String(norm(actual)) === String(norm(expected));
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
  // Dotted paths ('permissions.modules.confluence') keep their top-level field.
  fields.forEach((f) => {
    const top = f.split('.')[0];
    if (top in row) out[top] = row[top];
  });
  return out;
}

class FakeQuery {
  private projection?: string;
  private sortSpec?: Row;
  private limitN?: number;
  constructor(private run: () => any) {}
  select(spec: string) { this.projection = spec; return this; }
  sort(spec: Row) { this.sortSpec = spec; return this; }
  limit(n: number) { this.limitN = n; return this; }
  lean() { return this; }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve()
      .then(() => {
        let result = this.run();
        if (Array.isArray(result)) {
          if (this.sortSpec) {
            const [[k, dir]] = Object.entries(this.sortSpec);
            result = [...result].sort((a, b) => (norm(a[k]) > norm(b[k]) ? 1 : -1) * (dir as number));
          }
          if (this.limitN) result = result.slice(0, this.limitN);
          return result.map((r: Row) => copy(project(r, this.projection)));
        }
        return result ? copy(project(result, this.projection)) : result;
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
  Model.findOne = (filter: Row) => new FakeQuery(() => store.find((r) => matches(r, filter)) ?? null);
  Model.findById = (id: unknown) => Model.findOne({ _id: id });
  Model.countDocuments = async (filter: Row = {}) => store.filter((r) => matches(r, filter)).length;
  Model.findOneAndUpdate = (filter: Row, update: Row) =>
    new FakeQuery(() => {
      const row = store.find((r) => matches(r, filter));
      if (!row) return null;
      applyUpdate(row, update);
      row.updatedAt = tick();
      return row;
    });
  Model.updateOne = async (filter: Row, update: Row, opts: Row = {}) => {
    const row = store.find((r) => matches(r, filter));
    if (row) {
      applyUpdate(row, update);
      if (opts.timestamps !== false) row.updatedAt = tick();
    }
    return { modifiedCount: row ? 1 : 0 };
  };
  return Model as any;
}

const pageDefaults = (): Row => ({
  title: '', content: '', hasDraft: false, status: 'draft', parentId: null, path: [], isTemplate: false,
  labels: [], favoritedBy: [], restrictedTo: [], isDeleted: false
});

const mockFakes = {
  ConfluencePage: makeModel(pageDefaults),
  ConfluencePageVersion: makeModel((): Row => ({ labels: [] }), ['pageId', 'version']),
  ConfluencePageView: makeModel(() => ({})),
  ConfluenceComment: makeModel(() => ({ isDeleted: false })),
  User: makeModel(() => ({}))
};

jest.mock('../../models', () => mockFakes);

import * as controller from '../confluenceController';

/* ── Actors ───────────────────────────────────────────────────────────────── */

const ids = {
  publisher: new ObjectId(),  // view + create + edit + publish
  editor: new ObjectId(),     // view + edit (no publish)
  viewer: new ObjectId(),     // view + comment
  outsider: new ObjectId()    // view only, and NOT on restricted pages
};

const PERMS = {
  publisher: { view: true, create: true, edit: true, publish: true },
  editor: { view: true, edit: true },
  viewer: { view: true, comment: true },
  outsider: { view: true }
};

beforeAll(() => {
  for (const [name, _id] of Object.entries(ids)) {
    mockFakes.User.store.push({
      _id,
      displayName: name[0].toUpperCase() + name.slice(1),
      permissions: { modules: { confluence: PERMS[name as keyof typeof PERMS] } }
    });
  }
});

beforeEach(() => {
  mockFakes.ConfluencePage.store.length = 0;
  mockFakes.ConfluencePageVersion.store.length = 0;
});

type Actor = keyof typeof ids;

async function call(handler: (req: any, res: any) => Promise<void>, actor: Actor, params: Row = {}, body: Row = {}) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handler({ user: { _id: String(ids[actor]), role: 'member' }, params, body, query: {} }, res);
  return res as { statusCode: number; body: any };
}

async function createPublished(title = 'Login API', content = '<p>v1 body</p>', extra: Row = {}) {
  const res = await call(controller.createPage, 'publisher', {}, { title, content, publish: true, ...extra });
  expect(res.statusCode).toBe(201);
  return res.body.data.page._id as string;
}

async function saveDraft(pageId: string, title: string, content: string, actor: Actor = 'publisher') {
  return call(controller.saveDraft, actor, { id: pageId }, { title, content });
}

async function publish(pageId: string, title: string, content: string, actor: Actor = 'publisher') {
  return call(controller.publishPage, actor, { id: pageId }, { title, content });
}

const history = (pageId: string, actor: Actor = 'publisher') => call(controller.listVersions, actor, { id: pageId });
const getVersion = (pageId: string, version: number | string, actor: Actor = 'publisher') =>
  call(controller.getVersion, actor, { id: pageId, version: String(version) });
const restore = (pageId: string, version: number, actor: Actor = 'publisher') =>
  call(controller.restoreVersion, actor, { id: pageId, version: String(version) });

const versionNumbers = (res: any) => res.body.data.versions.map((v: any) => v.version);

/* ── Creating versions ────────────────────────────────────────────────────── */

describe('publishing creates versions', () => {
  it('first publish (create + publish) is version 1, with nothing archived', async () => {
    const pageId = await createPublished();
    const res = await history(pageId);
    expect(res.body.data.currentVersion).toBe(1);
    expect(versionNumbers(res)).toEqual([1]);
    expect(res.body.data.versions[0].isCurrent).toBe(true);
    expect(mockFakes.ConfluencePageVersion.store).toHaveLength(0);
  });

  it('first publish of an existing draft is version 1', async () => {
    const created = await call(controller.createPage, 'publisher', {}, { title: 'Draft page', content: '<p>d</p>' });
    const pageId = created.body.data.page._id;
    expect((await history(pageId)).body.data.versions).toEqual([]);

    const res = await call(controller.publishPage, 'publisher', { id: pageId }, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.page.currentVersion).toBe(1);
    expect(mockFakes.ConfluencePageVersion.store).toHaveLength(0);
  });

  it('each subsequent publish archives the previous version and increments the number', async () => {
    const pageId = await createPublished('Title v1', '<p>body v1</p>');
    expect((await publish(pageId, 'Title v2', '<p>body v2</p>')).body.data.page.currentVersion).toBe(2);
    expect((await publish(pageId, 'Title v3', '<p>body v3</p>')).body.data.page.currentVersion).toBe(3);

    const res = await history(pageId);
    expect(versionNumbers(res)).toEqual([3, 2, 1]);
    expect(res.body.data.versions.map((v: any) => v.title)).toEqual(['Title v3', 'Title v2', 'Title v1']);

    const v1 = await getVersion(pageId, 1);
    expect(v1.body.data.version).toMatchObject({ version: 1, title: 'Title v1', content: '<p>body v1</p>', isCurrent: false });
    const v2 = await getVersion(pageId, 2);
    expect(v2.body.data.version.content).toBe('<p>body v2</p>');
  });

  it('records who published each version', async () => {
    const pageId = await createPublished();
    await publish(pageId, 'Second', '<p>2</p>');
    const res = await history(pageId);
    expect(res.body.data.versions.every((v: any) => v.author?.displayName === 'Publisher')).toBe(true);
    expect(res.body.data.versions.every((v: any) => !!v.publishedAt)).toBe(true);
  });

  it('draft saves never create a version', async () => {
    const pageId = await createPublished();
    for (let i = 0; i < 3; i++) {
      expect((await saveDraft(pageId, `Working ${i}`, `<p>draft ${i}</p>`)).statusCode).toBe(200);
    }
    const res = await history(pageId);
    expect(res.body.data.currentVersion).toBe(1);
    expect(versionNumbers(res)).toEqual([1]);
    expect(mockFakes.ConfluencePageVersion.store).toHaveLength(0);
  });

  it('the current version is always the published content, never the draft', async () => {
    const pageId = await createPublished('Live', '<p>live</p>');
    await saveDraft(pageId, 'Unpublished', '<p>secret draft</p>');
    const current = await getVersion(pageId, 1, 'viewer');
    expect(current.body.data.version).toMatchObject({ title: 'Live', content: '<p>live</p>', isCurrent: true });
  });

  it('a page published before version history existed counts as version 1', async () => {
    const pageId = await createPublished('Legacy', '<p>old</p>');
    delete mockFakes.ConfluencePage.store[0].currentVersion; // as stored before this feature
    expect(versionNumbers(await history(pageId))).toEqual([1]);

    await publish(pageId, 'Legacy v2', '<p>new</p>');
    expect(versionNumbers(await history(pageId))).toEqual([2, 1]);
    expect((await getVersion(pageId, 1)).body.data.version.content).toBe('<p>old</p>');
  });

  it('tolerates an already-archived copy of the outgoing version (interrupted publish) without duplicates', async () => {
    const pageId = await createPublished('One', '<p>1</p>');
    await publish(pageId, 'Two', '<p>2</p>');
    // Simulate a publish that archived version 2 and then lost the page update.
    mockFakes.ConfluencePageVersion.store.push({
      ...mockFakes.ConfluencePageVersion.store[0], _id: new ObjectId(), version: 2
    });
    const res = await publish(pageId, 'Three', '<p>3</p>');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.page.currentVersion).toBe(3);
    expect(versionNumbers(await history(pageId))).toEqual([3, 2, 1]);
  });

  it('stores historical content encrypted at rest, keyed by the version document', async () => {
    const pageId = await createPublished('Secret title', '<p>secret body</p>');
    await publish(pageId, 'Next', '<p>next</p>');
    const [row] = mockFakes.ConfluencePageVersion.store;
    expect(row.title.startsWith('enc:v1:')).toBe(true);
    expect(row.content.startsWith('enc:v1:')).toBe(true);
    expect(row.content).not.toContain('secret body');
    expect(String(row.pageId)).toBe(pageId);
  });
});

/* ── History list ─────────────────────────────────────────────────────────── */

describe('history list', () => {
  it('returns metadata only — no version content', async () => {
    const pageId = await createPublished();
    await publish(pageId, 'v2', '<p>2</p>');
    const res = await history(pageId);
    for (const v of res.body.data.versions) expect(v).not.toHaveProperty('content');
  });

  it('is empty for a never-published draft', async () => {
    const created = await call(controller.createPage, 'publisher', {}, { title: 'D', content: '<p>d</p>' });
    const res = await history(created.body.data.page._id);
    expect(res.body.data).toMatchObject({ currentVersion: 0, versions: [], restoreMode: null });
  });
});

/* ── Restore ──────────────────────────────────────────────────────────────── */

describe('restore', () => {
  async function threeVersions() {
    const pageId = await createPublished('Title v1', '<p>body v1</p>');
    await publish(pageId, 'Title v2', '<p>body v2</p>');
    await publish(pageId, 'Title v3', '<p>body v3</p>');
    return pageId;
  }

  it('publishes the old content as a NEW version and keeps every existing version', async () => {
    const pageId = await threeVersions();
    const res = await restore(pageId, 2);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'publish', restoredFromVersion: 2, newVersion: 4 });
    expect(res.body.data.page).toMatchObject({ title: 'Title v2', content: '<p>body v2</p>', currentVersion: 4, restoredFromVersion: 2 });

    const list = await history(pageId);
    expect(versionNumbers(list)).toEqual([4, 3, 2, 1]);
    expect(list.body.data.versions[0]).toMatchObject({ version: 4, isCurrent: true, restoredFromVersion: 2 });
    // Nothing was overwritten: the version that was current before the restore is intact.
    expect((await getVersion(pageId, 3)).body.data.version).toMatchObject({ title: 'Title v3', content: '<p>body v3</p>' });
    expect((await getVersion(pageId, 1)).body.data.version.content).toBe('<p>body v1</p>');
  });

  it('can restore repeatedly; each restore is another new version', async () => {
    const pageId = await threeVersions();
    await restore(pageId, 1);
    const res = await restore(pageId, 3);
    expect(res.body.data.newVersion).toBe(5);
    expect(versionNumbers(await history(pageId))).toEqual([5, 4, 3, 2, 1]);
  });

  it('keeps an existing unpublished draft when restoring', async () => {
    const pageId = await threeVersions();
    await saveDraft(pageId, 'Pending edit', '<p>pending</p>');
    const res = await restore(pageId, 1);
    expect(res.body.data.page.hasDraft).toBe(true);
    expect(res.body.data.page.draft).toEqual({ title: 'Pending edit', content: '<p>pending</p>' });
  });

  it('an editor without publish restores into the draft only — nothing goes live, no version is created', async () => {
    const pageId = await threeVersions();
    const before = mockFakes.ConfluencePageVersion.store.length;
    const res = await restore(pageId, 1, 'editor');
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'draft', newVersion: null });
    expect(res.body.data.page).toMatchObject({ currentVersion: 3, title: 'Title v3', hasDraft: true });
    expect(res.body.data.page.draft).toEqual({ title: 'Title v1', content: '<p>body v1</p>' });
    expect(mockFakes.ConfluencePageVersion.store).toHaveLength(before);
    expect((await history(pageId)).body.data.restoreMode).toBe('publish'); // publisher's view
    expect((await history(pageId, 'editor')).body.data.restoreMode).toBe('draft');
  });

  it('a view-only user cannot restore (403) and nothing changes', async () => {
    const pageId = await threeVersions();
    const res = await restore(pageId, 1, 'viewer');
    expect(res.statusCode).toBe(403);
    expect(versionNumbers(await history(pageId))).toEqual([3, 2, 1]);
    expect((await history(pageId, 'viewer')).body.data.restoreMode).toBeNull();
  });

  it.each([
    ['the current version', 3, 400],
    ['a version that does not exist', 9, 404],
    ['version 0', 0, 400]
  ])('rejects restoring %s', async (_label, version, status) => {
    const pageId = await threeVersions();
    expect((await restore(pageId, version)).statusCode).toBe(status);
    expect(versionNumbers(await history(pageId))).toEqual([3, 2, 1]);
  });
});

/* ── Access control ───────────────────────────────────────────────────────── */

describe('access to history', () => {
  it('a view-only user can list history and open an old version', async () => {
    const pageId = await createPublished('One', '<p>1</p>');
    await publish(pageId, 'Two', '<p>2</p>');
    expect(versionNumbers(await history(pageId, 'viewer'))).toEqual([2, 1]);
    expect((await getVersion(pageId, 1, 'viewer')).body.data.version.content).toBe('<p>1</p>');
  });

  it('historical versions follow the page\'s CURRENT restriction — outsiders get 404 everywhere', async () => {
    const pageId = await createPublished('Restricted', '<p>v1 secret</p>');
    await publish(pageId, 'Restricted', '<p>v2</p>');
    // Restricted AFTER v1 was published: v1 must not stay readable to outsiders.
    await call(controller.updateRestrictions, 'publisher', { id: pageId }, { restrictedTo: [String(ids.viewer)] });

    for (const res of [await history(pageId, 'outsider'), await getVersion(pageId, 1, 'outsider'), await restore(pageId, 1, 'outsider')]) {
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
    // Someone on the restriction list still can.
    expect((await getVersion(pageId, 1, 'viewer')).body.data.version.content).toBe('<p>v1 secret</p>');
  });

  it('a deleted page\'s history is gone for everyone', async () => {
    const pageId = await createPublished();
    await publish(pageId, 'v2', '<p>2</p>');
    mockFakes.ConfluencePage.store[0].isDeleted = true;
    expect((await history(pageId)).statusCode).toBe(404);
    expect((await getVersion(pageId, 1)).statusCode).toBe(404);
  });

  it('version numbers are scoped to their page — another page\'s versions are unreachable', async () => {
    const pageA = await createPublished('A', '<p>A1</p>');
    await publish(pageA, 'A', '<p>A2</p>');
    const pageB = await createPublished('B', '<p>B1</p>');
    // B has only its current version 1; asking B for version 1 must return B's own content.
    expect((await getVersion(pageB, 1)).body.data.version.content).toBe('<p>B1</p>');
    expect((await getVersion(pageB, 2)).statusCode).toBe(404);
  });

  it('rejects malformed version numbers', async () => {
    const pageId = await createPublished();
    expect((await getVersion(pageId, 'abc')).statusCode).toBe(400);
    expect((await getVersion(pageId, '1e3')).statusCode).toBe(400);
  });

  it('an invalid or unknown page id stays a plain 400/404', async () => {
    expect((await history('not-an-id')).statusCode).toBe(400);
    expect((await history(String(new ObjectId()))).statusCode).toBe(404);
  });
});
