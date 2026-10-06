/**
 * Confluence presence (Phase 5A) — "who is editing this page", over the existing
 * Socket.IO server. Driven end-to-end: the REAL presence module and the REAL
 * controller share the in-memory model fakes below (the block from
 * confluenceReview.test.ts, verbatim — this repo keeps fakes per test file), so
 * access checks run the same rules the REST API does.
 *
 * Properties under test:
 * - only users who may see the draft can join; only editors are listed as editing,
 * - restricted pages answer exactly like missing pages and leak nothing,
 * - presence disappears on leave / disconnect / heartbeat timeout,
 * - the review lock stays authoritative (no editors while in review; REST 423),
 * - collaboration never creates versions; publish still creates exactly one,
 * - change signals carry no content, and the 409 protection is unchanged.
 */

import mongoose from 'mongoose';

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));
jest.mock('../../utils/imageCompression', () => ({ compressUploadedImage: jest.fn() }));
jest.mock('../../controllers/notificationController', () => ({ createNotification: jest.fn(async () => ({})) }));

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

import * as controller from '../../controllers/confluenceController';
import {
  registerConfluencePresence,
  sweepNow,
  __resetConfluencePresence,
  PRESENCE_TTL_MS,
  ConfluencePresenceStore
} from '../confluencePresence';

/* ── Actors ───────────────────────────────────────────────────────────────── */

const actors = {
  author: { _id: new ObjectId(), displayName: 'Akhilesh', perms: { view: true, create: true, comment: true } },
  editor: { _id: new ObjectId(), displayName: 'Esha', perms: { view: true, edit: true, comment: true } },
  reviewer: { _id: new ObjectId(), displayName: 'Priya', perms: { view: true, create: true, edit: true, publish: true, comment: true } },
  // May see drafts (publish) but not edit: a viewer, never an editor.
  publishOnly: { _id: new ObjectId(), displayName: 'Pooja', perms: { view: true, publish: true } },
  // Reads published pages only — no draft visibility.
  reader: { _id: new ObjectId(), displayName: 'Reader', perms: { view: true, comment: true } },
  // Full rights, but will be outside a page restriction.
  outsider: { _id: new ObjectId(), displayName: 'Omar', perms: { view: true, edit: true, publish: true } },
  // No Confluence access at all.
  stranger: { _id: new ObjectId(), displayName: 'Stan', perms: {} }
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

/* ── Fake io + sockets ────────────────────────────────────────────────────── */

interface Delivery { socketId: string; event: string; payload: any }
let deliveries: Delivery[] = [];
const rooms = new Map<string, Set<string>>(); // room -> socket ids
const left: Array<{ socketId: string; room: string }> = [];

const io: any = {
  to: (room: string) => ({
    emit: (event: string, payload: any) => {
      for (const socketId of rooms.get(room) || []) deliveries.push({ socketId, event, payload: copy(payload) });
    }
  }),
  in: (socketId: string) => ({
    socketsLeave: (room: string) => {
      rooms.get(room)?.delete(socketId);
      left.push({ socketId, room });
    }
  })
};

let socketSeq = 0;
function connect(actor: ActorName) {
  const handlers = new Map<string, Function>();
  const socket: any = {
    id: `sock-${++socketSeq}-${actor}`,
    user: { _id: actors[actor]._id },
    disconnected: false,
    on: (event: string, handler: Function) => handlers.set(event, handler),
    join: (room: string) => {
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room)!.add(socket.id);
    }
  };
  registerConfluencePresence(io, socket);
  // Resolves with the ack, or undefined once the handler finished without one.
  const fire = (event: string, payload?: unknown) =>
    new Promise<any>((resolve) => {
      Promise.resolve(handlers.get(event)!(payload, resolve)).then(() => resolve(undefined));
    });
  return {
    socket,
    handlers,
    join: (pageId: string, editing = true) => fire('confluence:presence:join', { pageId, editing }),
    heartbeat: (pageId: string, editing = true) => fire('confluence:presence:heartbeat', { pageId, editing }),
    leave: (pageId: string) => fire('confluence:presence:leave', { pageId }),
    disconnect: () => { socket.disconnected = true; handlers.get('disconnecting')!(); },
    received: (event?: string) => deliveries.filter((d) => d.socketId === socket.id && (!event || d.event === event)),
    lastPresence: () => {
      const mine = deliveries.filter((d) => d.socketId === socket.id && d.event === 'confluence:presence');
      return mine.length ? mine[mine.length - 1].payload.editors.map((e: any) => e.displayName) : undefined;
    },
    inRoom: (pageId: string) => !!rooms.get(`confluence:page:${pageId}`)?.has(socket.id)
  };
}

/** Lets fire-and-forget revalidation (after restrict/move/delete/review) finish. */
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

let store: ConfluencePresenceStore;
beforeEach(() => {
  for (const key of ['ConfluencePage', 'ConfluencePageVersion', 'ConfluencePageView', 'ConfluenceComment', 'AuditLog'] as const) {
    mockModels[key].store.length = 0;
  }
  clock += 60 * 60 * 1000;
  deliveries = [];
  rooms.clear();
  left.length = 0;
  store = __resetConfluencePresence({}, io);
});

afterAll(() => { __resetConfluencePresence(); });

/* ── REST helpers (same shapes as the other Confluence suites) ────────────── */

async function call(handler: (req: any, res: any) => Promise<void>, actor: ActorName, params: Row = {}, body: Row = {}) {
  const a = actors[actor];
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handler({ user: { _id: String(a._id), displayName: a.displayName, role: 'member' }, params, body, query: {} }, res);
  return res as { statusCode: number; body: any };
}
const id = (actor: ActorName) => String(actors[actor]._id);
const pageOf = async (pageId: string, actor: ActorName = 'reviewer') => (await call(controller.getPage, actor, { id: pageId })).body.data.page;
const token = async (pageId: string, actor: ActorName = 'reviewer') => new Date((await pageOf(pageId, actor)).updatedAt).toISOString();
const versions = async (pageId: string) =>
  (await call(controller.listVersions, 'reviewer', { id: pageId })).body.data.versions.map((v: any) => v.version);
const saveDraft = (pageId: string, actor: ActorName, content: string, extra: Row = {}) =>
  call(controller.saveDraft, actor, { id: pageId }, { title: 'LOS Documentation', content, ...extra });

/** Published once by the reviewer ("LOS Documentation", v1). */
async function publishedPage() {
  const res = await call(controller.createPage, 'reviewer', {}, { title: 'LOS Documentation', content: '<p>v1</p>', publish: true });
  return res.body.data.page._id as string;
}

/* ── Joining ──────────────────────────────────────────────────────────────── */

describe('joining page presence', () => {
  it('an authorized editor joins and appears to everyone present', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    const esha = connect('editor');

    expect(await priya.join(pageId)).toEqual({ ok: true, userId: id('reviewer'), canEdit: true, editors: [{ userId: id('reviewer'), displayName: 'Priya' }] });
    const ack = await esha.join(pageId);
    expect(ack.editors.map((e: any) => e.displayName)).toEqual(['Esha', 'Priya']);
    expect(priya.lastPresence()).toEqual(['Esha', 'Priya']);
    expect(esha.inRoom(pageId)).toBe(true);
  });

  it('the same person in two tabs is listed once', async () => {
    const pageId = await publishedPage();
    await connect('editor').join(pageId);
    expect((await connect('editor').join(pageId)).editors).toHaveLength(1);
  });

  it('refuses users who may not see the draft — with the same bare answer as a missing page', async () => {
    const pageId = await publishedPage();
    const missing = String(new ObjectId());
    for (const actor of ['reader', 'stranger'] as ActorName[]) {
      const s = connect(actor);
      expect(await s.join(pageId)).toEqual({ ok: false });
      expect(await s.join(missing)).toEqual({ ok: false });
      expect(s.inRoom(pageId)).toBe(false);
    }
    expect(await connect('reviewer').join('not-an-id')).toEqual({ ok: false });
    expect(store.editorsOf(pageId)).toEqual([]);
  });

  it('a view-only user (draft visibility, no edit right) can watch but never becomes an editor', async () => {
    const pageId = await publishedPage();
    const pooja = connect('publishOnly');
    expect(await pooja.join(pageId, true)).toEqual({ ok: true, userId: id('publishOnly'), canEdit: false, editors: [] });
    await connect('editor').join(pageId);
    expect(pooja.lastPresence()).toEqual(['Esha']);
  });

  it('an author sees presence on their own unpublished page; readers cannot even confirm it exists', async () => {
    const created = await call(controller.createPage, 'author', {}, { title: 'Secret plan', content: '<p>d</p>' });
    const pageId = created.body.data.page._id;
    expect((await connect('author').join(pageId)).ok).toBe(true);
    expect(await connect('reader').join(pageId)).toEqual({ ok: false });
  });

  it('caps how many pages one socket can be present on', async () => {
    const s = connect('reviewer');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await publishedPage());
    for (let i = 0; i < 5; i++) expect((await s.join(ids[i])).ok).toBe(true);
    expect(await s.join(ids[5])).toEqual({ ok: false });
  });
});

/* ── Restricted pages ─────────────────────────────────────────────────────── */

describe('restricted pages', () => {
  it('someone outside the restriction cannot join and receives nothing', async () => {
    const pageId = await publishedPage();
    await call(controller.updateRestrictions, 'reviewer', { id: pageId }, { restrictedTo: [id('editor')] });
    const omar = connect('outsider');
    expect(await omar.join(pageId)).toEqual({ ok: false });

    await connect('editor').join(pageId);
    await saveDraft(pageId, 'editor', '<p>secret draft</p>');
    expect(omar.received()).toEqual([]);
  });

  it('a child of a restricted page is hidden too', async () => {
    const parentId = await publishedPage();
    const child = await call(controller.createPage, 'reviewer', {}, { title: 'Child', content: '<p>c</p>', parentId, publish: true });
    await call(controller.updateRestrictions, 'reviewer', { id: parentId }, { restrictedTo: [id('editor')] });
    expect(await connect('outsider').join(child.body.data.page._id)).toEqual({ ok: false });
  });

  it('restricting a page evicts people who just lost access', async () => {
    const pageId = await publishedPage();
    const omar = connect('outsider');
    const esha = connect('editor');
    await omar.join(pageId);
    await esha.join(pageId);
    expect(esha.lastPresence()).toEqual(['Esha', 'Omar']);

    await call(controller.updateRestrictions, 'reviewer', { id: pageId }, { restrictedTo: [id('editor')] });
    await flush();
    expect(esha.lastPresence()).toEqual(['Esha']);
    expect(omar.inRoom(pageId)).toBe(false);

    const before = omar.received().length;
    await saveDraft(pageId, 'editor', '<p>after restriction</p>');
    expect(omar.received()).toHaveLength(before);
    // And they cannot sneak back in with a heartbeat.
    expect(await omar.heartbeat(pageId)).toEqual({ ok: false });
  });

  it('a deleted page tells the people present, then drops them', async () => {
    // An author may delete their own never-published draft.
    const created = await call(controller.createPage, 'author', {}, { title: 'Scratch', content: '<p>d</p>' });
    const pageId = created.body.data.page._id;
    const esha = connect('editor');
    await esha.join(pageId);
    expect((await call(controller.deletePage, 'author', { id: pageId })).statusCode).toBe(200);
    await flush();
    expect(esha.received('confluence:page:changed').map((d) => d.payload.kind)).toEqual(['deleted']);
    expect(esha.inRoom(pageId)).toBe(false);
    expect(store.size).toBe(0);
  });
});

/* ── Leaving / stale presence ─────────────────────────────────────────────── */

describe('presence cleanup', () => {
  it('disappears when a user leaves (navigation away)', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    const esha = connect('editor');
    await priya.join(pageId);
    await esha.join(pageId);
    await esha.leave(pageId);
    expect(priya.lastPresence()).toEqual(['Priya']);
    expect(esha.inRoom(pageId)).toBe(false);
  });

  it('disappears on disconnect (tab close, refresh, network drop noticed by the server)', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    const esha = connect('editor');
    await priya.join(pageId);
    await esha.join(pageId);
    esha.disconnect();
    expect(priya.lastPresence()).toEqual(['Priya']);
    expect(store.pageCountFor(esha.socket.id)).toBe(0);
  });

  it('expires after the heartbeat timeout; heartbeats keep it alive', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    const esha = connect('editor');
    await priya.join(pageId);
    await esha.join(pageId);

    clock += 40_000;
    await priya.heartbeat(pageId);
    clock += 40_000; // Esha silent for 80s, Priya for 40s
    sweepNow();
    expect(priya.lastPresence()).toEqual(['Priya']);
    expect(left).toEqual([{ socketId: esha.socket.id, room: `confluence:page:${pageId}` }]);

    clock += PRESENCE_TTL_MS + 1;
    sweepNow();
    expect(store.size).toBe(0);
  });

  it('a reconnecting client simply joins again', async () => {
    const pageId = await publishedPage();
    const first = connect('editor');
    await first.join(pageId);
    first.disconnect();
    expect(store.size).toBe(0);
    expect((await connect('editor').join(pageId)).editors.map((e: any) => e.displayName)).toEqual(['Esha']);
  });

  it('a leave that arrives while a join is still being checked wins', async () => {
    const pageId = await publishedPage();
    const esha = connect('editor');
    const joining = esha.join(pageId);
    await esha.leave(pageId);
    await joining;
    expect(store.editorsOf(pageId)).toEqual([]);
    expect(esha.inRoom(pageId)).toBe(false);
  });

  it('only listens to presence events — no socket event can write page content', () => {
    expect([...connect('editor').handlers.keys()].sort()).toEqual([
      'confluence:presence:heartbeat',
      'confluence:presence:join',
      'confluence:presence:leave',
      'disconnecting'
    ]);
  });
});

/* ── Review lock ──────────────────────────────────────────────────────────── */

describe('review lock stays authoritative', () => {
  it('submitting for review drops every editor; nobody can edit while in review; withdraw restores', async () => {
    const pageId = await publishedPage();
    await saveDraft(pageId, 'editor', '<p>v2 draft</p>');
    const esha = connect('editor');
    const priya = connect('reviewer');
    await esha.join(pageId);
    await priya.join(pageId);

    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    await flush();
    expect(priya.lastPresence()).toEqual([]);
    expect(priya.received('confluence:page:changed').map((d) => d.payload.kind)).toEqual(['review_submitted']);
    // A fresh join while in review can watch but not edit…
    expect(await connect('outsider').join(pageId)).toEqual({ ok: true, userId: id('outsider'), canEdit: false, editors: [] });
    // …and the REST lock is unchanged: the draft cannot be written, forced or not.
    expect((await saveDraft(pageId, 'editor', '<p>sneaky</p>')).statusCode).toBe(423);
    expect((await saveDraft(pageId, 'reviewer', '<p>sneaky</p>', { force: true })).statusCode).toBe(423);
    expect((await pageOf(pageId)).draft.content).toBe('<p>v2 draft</p>');

    // Once the lock lifts, everyone who has the editor open is an editor again
    // (Omar asked to edit while it was locked).
    await call(controller.withdrawReview, 'editor', { id: pageId }, {});
    await flush();
    expect(priya.lastPresence()).toEqual(['Esha', 'Omar', 'Priya']);
  });

  it('approval through the review workflow still publishes exactly one version', async () => {
    const pageId = await publishedPage();
    await connect('editor').join(pageId);
    await saveDraft(pageId, 'editor', '<p>v2 draft</p>');
    await call(controller.submitForReview, 'editor', { id: pageId }, {});
    const res = await call(controller.approveReview, 'reviewer', { id: pageId }, { expectedUpdatedAt: await token(pageId) });
    expect(res.statusCode).toBe(200);
    expect(await versions(pageId)).toEqual([2, 1]);
  });
});

/* ── Versions + concurrency ───────────────────────────────────────────────── */

describe('collaborative drafts, versions and concurrency', () => {
  it('draft saves never create versions; one publish creates exactly one', async () => {
    const pageId = await publishedPage();
    await connect('reviewer').join(pageId);
    await connect('editor').join(pageId);

    for (const n of [1, 2, 3]) {
      expect((await saveDraft(pageId, n % 2 ? 'editor' : 'reviewer', `<p>draft ${n}</p>`)).statusCode).toBe(200);
    }
    expect(await versions(pageId)).toEqual([1]);

    expect((await call(controller.publishPage, 'reviewer', { id: pageId }, {})).statusCode).toBe(200);
    expect(await versions(pageId)).toEqual([2, 1]);
    expect((await pageOf(pageId, 'reader')).content).toBe('<p>draft 3</p>');
  });

  it('change signals say who changed what — never the content or title', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    await priya.join(pageId);
    const res = await saveDraft(pageId, 'editor', '<p>confidential numbers</p>');

    const signals = priya.received('confluence:page:changed');
    expect(signals).toHaveLength(1);
    expect(signals[0].payload).toEqual({
      pageId,
      kind: 'draft_saved',
      updatedAt: new Date(res.body.data.page.updatedAt).toISOString(),
      by: { userId: id('editor'), displayName: 'Esha' }
    });
    expect(JSON.stringify(deliveries)).not.toMatch(/confidential|LOS Documentation/);
  });

  it('keeps the 409 protection: saving over a collaborator\'s newer draft is refused unless confirmed', async () => {
    const pageId = await publishedPage();
    await connect('editor').join(pageId);
    await connect('reviewer').join(pageId);
    const seenByBoth = await token(pageId);

    expect((await saveDraft(pageId, 'editor', '<p>Esha</p>', { expectedUpdatedAt: seenByBoth })).statusCode).toBe(200);
    expect((await saveDraft(pageId, 'reviewer', '<p>Priya</p>', { expectedUpdatedAt: seenByBoth })).statusCode).toBe(409);
    expect((await pageOf(pageId)).draft.content).toBe('<p>Esha</p>');
    // The existing explicit "Overwrite" path still works.
    expect((await saveDraft(pageId, 'reviewer', '<p>Priya</p>', { expectedUpdatedAt: seenByBoth, force: true })).statusCode).toBe(200);
  });

  it('a refused save sends no signal', async () => {
    const pageId = await publishedPage();
    const priya = connect('reviewer');
    await priya.join(pageId);
    const stale = await token(pageId);
    await saveDraft(pageId, 'editor', '<p>a</p>');
    deliveries = [];
    expect((await saveDraft(pageId, 'editor', '<p>b</p>', { expectedUpdatedAt: stale })).statusCode).toBe(409);
    expect(priya.received('confluence:page:changed')).toEqual([]);
  });
});
