/**
 * Personal Files: ownership isolation, folder-tree integrity and storage safety.
 *
 * Unlike the other controller tests in this suite (which assert on mock calls),
 * these run against a small IN-MEMORY fake of the subset of Mongoose the
 * controller actually uses, plus an in-memory filesystem. That is deliberate:
 * the properties worth protecting here are behavioural (a folder cannot end up
 * inside itself; deleting a folder must take its whole subtree; user A must not
 * reach user B's bytes) and a call-assertion test cannot demonstrate any of them.
 *
 * Field encryption is NOT mocked — the real utility runs, so these also prove the
 * encrypt-with-own-id / decrypt-before-response round trip works for names and
 * storage paths.
 *
 * Actor/target model: USER_A is the caller throughout; anything suffixed _B
 * belongs to USER_B and must be unreachable.
 */

import mongoose from 'mongoose';

// ── In-memory filesystem ─────────────────────────────────────────────────────
// Keyed by absolute path. `path` itself is NOT mocked, so traversal assertions
// exercise the real resolution logic.
const memFs = new Map<string, string>();

jest.mock('fs', () => ({
  existsSync: jest.fn((p: string) => memFs.has(String(p))),
  mkdirSync: jest.fn(),
  createReadStream: jest.fn((p: string) => {
    const stream: any = {
      on: jest.fn(() => stream),
      pipe: jest.fn((dest: any) => {
        dest.__streamedFrom = String(p);
        dest.__streamedBody = memFs.get(String(p));
        return dest;
      })
    };
    return stream;
  })
}));

jest.mock('fs/promises', () => ({
  unlink: jest.fn(async (p: string) => {
    if (!memFs.has(String(p))) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    memFs.delete(String(p));
  }),
  stat: jest.fn(async (p: string) => {
    if (!memFs.has(String(p))) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return { size: Buffer.byteLength(memFs.get(String(p)) as string) };
  }),
  copyFile: jest.fn(async (src: string, dest: string) => {
    if (!memFs.has(String(src))) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    memFs.set(String(dest), memFs.get(String(src)) as string);
  })
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}));

// ── In-memory PersonalFile model ─────────────────────────────────────────────
// Supports exactly the query shapes the controller uses. Anything unsupported
// throws loudly rather than silently returning nothing, so a future query shape
// cannot quietly slip past these tests.

type Row = Record<string, any>;
const store: Row[] = [];

function newId(): string {
  return new mongoose.Types.ObjectId().toString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

const SUPPORTED_KEYS = new Set(['_id', 'userId', 'type', 'isDeleted', 'parentId', 'path']);

function matches(row: Row, filter: Row): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(`fake model: unsupported filter key "${key}"`);
    }
    const actual = row[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) {
        const list = (expected.$in as any[]).map((v) => String(v));
        if (!list.includes(String(actual))) return false;
        continue;
      }
      throw new Error(`fake model: unsupported operator in "${key}"`);
    }
    if (key === 'path') {
      // Mongo array-contains semantics: { path: id } matches a document whose
      // path array includes id. This is what subtree resolution relies on.
      const arr = (actual || []).map((v: any) => String(v));
      if (!arr.includes(String(expected))) return false;
      continue;
    }
    if (key === 'parentId') {
      const a = actual === null || actual === undefined ? null : String(actual);
      const b = expected === null || expected === undefined ? null : String(expected);
      if (a !== b) return false;
      continue;
    }
    if (expected === null || expected === undefined) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (typeof expected === 'boolean') {
      if (!!actual !== expected) return false;
      continue;
    }
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function applyUpdate(row: Row, update: Row): void {
  if (update.$set) Object.assign(row, clone(update.$set));
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete row[k];
}

function chainable(rows: Row[]) {
  const chain: any = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    lean: jest.fn(async () => rows.map(clone))
  };
  return chain;
}

/** A hydrated-document stand-in: mutable, with save()/toObject() like Mongoose. */
function hydrate(row: Row) {
  const doc: any = { ...row };
  doc.save = jest.fn(async () => {
    const target = store.find((r) => String(r._id) === String(doc._id));
    if (target) {
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v === 'function') continue;
        target[k] = v;
      }
    }
    return doc;
  });
  doc.toObject = jest.fn(() => {
    const plain: Row = {};
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v === 'function') continue;
      plain[k] = v;
    }
    return plain;
  });
  return doc;
}

const PersonalFileMock: any = function PersonalFileCtor(this: any, data: Row) {
  const row: Row = {
    _id: newId(),
    isDeleted: false,
    path: [],
    parentId: null,
    ...data,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  Object.assign(this, row);
  this.save = jest.fn(async () => {
    const plain: Row = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === 'function') continue;
      plain[k] = v;
    }
    const existing = store.find((r) => String(r._id) === String(plain._id));
    if (existing) Object.assign(existing, plain);
    else store.push(plain);
    return this;
  });
  this.toObject = jest.fn(() => {
    const plain: Row = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === 'function') continue;
      plain[k] = v;
    }
    return plain;
  });
};

PersonalFileMock.find = jest.fn((filter: Row = {}) => chainable(store.filter((r) => matches(r, filter))));
PersonalFileMock.findOne = jest.fn((filter: Row = {}) => {
  const row = store.find((r) => matches(r, filter));
  const chain: any = {
    lean: jest.fn(async () => (row ? clone(row) : null)),
    select: jest.fn(() => chain),
    // Awaiting findOne() directly (no .lean()) yields a hydrated document, which
    // is what renameItem relies on.
    then: (resolve: any, reject: any) =>
      Promise.resolve(row ? hydrate(row) : null).then(resolve, reject)
  };
  return chain;
});
PersonalFileMock.updateOne = jest.fn(async (filter: Row, update: Row) => {
  const row = store.find((r) => matches(r, filter));
  if (!row) return { modifiedCount: 0 };
  applyUpdate(row, update);
  return { modifiedCount: 1 };
});
PersonalFileMock.updateMany = jest.fn(async (filter: Row, update: Row) => {
  const rows = store.filter((r) => matches(r, filter));
  rows.forEach((r) => applyUpdate(r, update));
  return { modifiedCount: rows.length };
});
PersonalFileMock.bulkWrite = jest.fn(async (ops: any[]) => {
  for (const op of ops) {
    const { filter, update } = op.updateOne;
    const row = store.find((r) => matches(r, filter));
    if (row) applyUpdate(row, update);
  }
  return { modifiedCount: ops.length };
});
PersonalFileMock.deleteMany = jest.fn(async (filter: Row) => {
  const doomed = store.filter((r) => matches(r, filter));
  for (const d of doomed) store.splice(store.indexOf(d), 1);
  return { deletedCount: doomed.length };
});
PersonalFileMock.countDocuments = jest.fn(async (filter: Row) => store.filter((r) => matches(r, filter)).length);
PersonalFileMock.aggregate = jest.fn(async (pipeline: any[]) => {
  // Only the usage pipeline is used: $match on { userId, type } then $group by isDeleted.
  const match = pipeline[0].$match;
  const rows = store.filter(
    (r) => String(r.userId) === String(match.userId) && r.type === match.type
  );
  const groups = new Map<boolean, { _id: boolean; bytes: number; count: number }>();
  for (const r of rows) {
    const key = !!r.isDeleted;
    const g = groups.get(key) || { _id: key, bytes: 0, count: 0 };
    g.bytes += r.size || 0;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
});

/** The controller reads User to resolve the bulk operation's module permission.
 *  Defaults to a fully-permitted member; individual tests override it. */
const UserMock: any = {
  findById: jest.fn(() => ({
    select: jest.fn().mockResolvedValue({
      permissions: { modules: { personalFiles: { view: true, create: true, edit: true, delete: true } } }
    })
  }))
};

/** Points UserMock at a specific personalFiles permission object. */
function setPersonalFilesPermissions(personalFiles: any) {
  UserMock.findById = jest.fn(() => ({
    select: jest.fn().mockResolvedValue({ permissions: { modules: { personalFiles } } })
  }));
}

jest.mock('../../models', () => ({ PersonalFile: PersonalFileMock, User: UserMock }));

import {
  listItems,
  getTree,
  getBreadcrumb,
  createFolder,
  uploadFile,
  renameItem,
  moveItem,
  copyItem,
  deleteItem,
  restoreItem,
  permanentDeleteItem,
  listRecycleBin,
  bulkOperation,
  searchItems,
  getUsage,
  downloadFile,
  validatePersonalFileName,
  resolvePersonalFilePath,
  isForcedDownloadMime,
  isInlinePreviewableMime,
  sanitizeDispositionFilename
} from '../personalFilesController';
import { encryptField, decryptField } from '../../utils/fieldEncryption';
import {
  PERSONAL_FILES_DIR,
  PERSONAL_FILES_RELATIVE_PREFIX,
  PERSONAL_FILES_QUOTA_BYTES,
  PERSONAL_FILES_MAX_NAME_LENGTH
} from '../../config/personalFiles';

import path from 'path';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';

function makeRes() {
  const res: any = { headersSent: false, __headers: {} as Record<string, string> };
  res.status = jest.fn((code: number) => {
    res.__status = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.__body = body;
    return res;
  });
  res.setHeader = jest.fn((k: string, v: string) => {
    res.__headers[k] = v;
    return res;
  });
  res.destroy = jest.fn();
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A' },
    params: {},
    query: {},
    body: {},
    ...overrides
  } as any;
}

function status(res: any): number {
  return res.__status;
}

function body(res: any): any {
  return res.__body;
}

function data(res: any): any {
  return res.__body?.data;
}

/** Seeds a folder directly into the store, with its name encrypted the same way
 *  the controller would write it. */
function seedFolder(opts: {
  userId?: string;
  name: string;
  parentId?: string | null;
  path?: string[];
  isDeleted?: boolean;
}): Row {
  const id = newId();
  const row: Row = {
    _id: id,
    userId: opts.userId || USER_A,
    type: 'folder',
    name: encryptField(opts.name, id) as string,
    parentId: opts.parentId ?? null,
    path: opts.path || [],
    isDeleted: opts.isDeleted ?? false,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  store.push(row);
  return row;
}

/** Seeds a file plus its physical bytes in the in-memory filesystem. */
function seedFile(opts: {
  userId?: string;
  name: string;
  parentId?: string | null;
  path?: string[];
  mimeType?: string;
  size?: number;
  content?: string;
  isDeleted?: boolean;
  storagePath?: string;
  onDisk?: boolean;
}): Row {
  const id = newId();
  const physical = `${Date.now()}-${id}.bin`;
  const relative = opts.storagePath ?? `${PERSONAL_FILES_RELATIVE_PREFIX}/${physical}`;
  const content = opts.content ?? 'file-bytes';
  const row: Row = {
    _id: id,
    userId: opts.userId || USER_A,
    type: 'file',
    name: encryptField(opts.name, id) as string,
    parentId: opts.parentId ?? null,
    path: opts.path || [],
    storagePath: encryptField(relative, id) as string,
    originalName: encryptField(opts.name, id) as string,
    mimeType: opts.mimeType || 'application/pdf',
    size: opts.size ?? Buffer.byteLength(content),
    isDeleted: opts.isDeleted ?? false,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  store.push(row);
  if (opts.onDisk !== false) {
    const abs = path.resolve(PERSONAL_FILES_DIR, relative.replace(`${PERSONAL_FILES_RELATIVE_PREFIX}/`, ''));
    memFs.set(abs, content);
  }
  return row;
}

/** Simulates what multer leaves behind before uploadFile runs. */
function seedUploadedFile(filename: string, content: string) {
  const abs = path.join(PERSONAL_FILES_DIR, filename);
  memFs.set(abs, content);
  return {
    filename,
    originalname: filename,
    mimetype: 'application/pdf',
    size: Buffer.byteLength(content),
    path: abs
  };
}

function nameOf(row: Row): string {
  return decryptField(row.name, String(row._id)) as string;
}

beforeEach(() => {
  store.length = 0;
  memFs.clear();
  setPersonalFilesPermissions({ view: true, create: true, edit: true, delete: true });
});

/* ═══════════════════════════════════════════════════════════════════════════
   1-4: create and list
   ═══════════════════════════════════════════════════════════════════════════ */

describe('createFolder / listItems — the basic tree', () => {
  it('creates a folder at the root and stores its name encrypted', async () => {
    const res = makeRes();

    await createFolder(makeReq({ body: { name: 'Documents', parentId: null } }), res);

    expect(status(res)).toBe(201);
    expect(data(res).item.name).toBe('Documents');
    expect(data(res).item.parentId).toBeNull();
    expect(data(res).item.path).toEqual([]);
    // Stored at rest as ciphertext, not plaintext.
    expect(store[0].name).not.toBe('Documents');
    expect(store[0].name.startsWith('enc:v1:')).toBe(true);
    expect(nameOf(store[0])).toBe('Documents');
  });

  it('creates a nested folder and records the full ancestor path', async () => {
    const docs = seedFolder({ name: 'Documents' });
    const res = makeRes();

    await createFolder(makeReq({ body: { name: 'Work', parentId: String(docs._id) } }), res);

    expect(status(res)).toBe(201);
    expect(data(res).item.parentId).toBe(String(docs._id));
    expect(data(res).item.path).toEqual([String(docs._id)]);
  });

  it('records a three-level ancestor path root-most first', async () => {
    const docs = seedFolder({ name: 'Documents' });
    const work = seedFolder({ name: 'Work', parentId: String(docs._id), path: [String(docs._id)] });
    const res = makeRes();

    await createFolder(makeReq({ body: { name: 'Q3', parentId: String(work._id) } }), res);

    expect(data(res).item.path).toEqual([String(docs._id), String(work._id)]);
  });

  it('lists the root — children only, never descendants', async () => {
    const docs = seedFolder({ name: 'Documents' });
    seedFolder({ name: 'Work', parentId: String(docs._id), path: [String(docs._id)] });
    seedFile({ name: 'Example.pdf' });
    const res = makeRes();

    await listItems(makeReq({ query: {} }), res);

    const names = data(res).items.map((i: any) => i.name).sort();
    expect(names).toEqual(['Documents', 'Example.pdf']);
    expect(data(res).parentId).toBeNull();
  });

  it('lists a nested folder addressed by parentId', async () => {
    const docs = seedFolder({ name: 'Documents' });
    seedFile({ name: 'Report.pdf', parentId: String(docs._id), path: [String(docs._id)] });
    const res = makeRes();

    await listItems(makeReq({ query: { parentId: String(docs._id) } }), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['Report.pdf']);
  });

  it('omits soft-deleted children from a listing', async () => {
    seedFolder({ name: 'Kept' });
    seedFolder({ name: 'Trashed', isDeleted: true });
    const res = makeRes();

    await listItems(makeReq({ query: {} }), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['Kept']);
  });

  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await listItems(makeReq({ user: null }), res);

    expect(status(res)).toBe(401);
    expect(body(res).success).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5: upload
   ═══════════════════════════════════════════════════════════════════════════ */

describe('uploadFile', () => {
  it('stores a file, keeps physical storage flat and never returns storagePath', async () => {
    const docs = seedFolder({ name: 'Documents' });
    const uploaded = seedUploadedFile('1700000000-uuid.pdf', 'hello-pdf');
    const res = makeRes();

    await uploadFile(
      makeReq({ file: uploaded, body: { parentId: String(docs._id) } }),
      res
    );

    expect(status(res)).toBe(201);
    const item = data(res).item;
    expect(item.name).toBe('1700000000-uuid.pdf');
    expect(item.parentId).toBe(String(docs._id));
    expect(item.size).toBe(Buffer.byteLength('hello-pdf'));
    // The physical location is server-only and must never reach a client.
    expect(item.storagePath).toBeUndefined();

    // Stored path is RELATIVE and encrypted at rest.
    const row = store.find((r) => r.type === 'file') as Row;
    expect(row.storagePath.startsWith('enc:v1:')).toBe(true);
    const decrypted = decryptField(row.storagePath, String(row._id)) as string;
    expect(decrypted).toBe(`${PERSONAL_FILES_RELATIVE_PREFIX}/1700000000-uuid.pdf`);
    expect(path.isAbsolute(decrypted)).toBe(false);
    // Flat: exactly one path segment below the prefix, no mirrored folder tree.
    expect(decrypted.split('/').length).toBe(2);
  });

  it('uses the on-disk size rather than a client-declared size', async () => {
    const uploaded = seedUploadedFile('x.pdf', 'exactly-fifteen');
    uploaded.size = 1; // a lying client
    const res = makeRes();

    await uploadFile(makeReq({ file: uploaded, body: {} }), res);

    expect(data(res).item.size).toBe(Buffer.byteLength('exactly-fifteen'));
  });

  it('auto-suffixes rather than failing when the name is already taken', async () => {
    seedFile({ name: 'dup.pdf' });
    const uploaded = seedUploadedFile('phys-dup.pdf', 'bytes');
    uploaded.originalname = 'dup.pdf';
    const res = makeRes();

    await uploadFile(makeReq({ file: uploaded, body: {} }), res);

    expect(status(res)).toBe(201);
    expect(data(res).item.name).toBe('dup (2).pdf');
  });

  it('removes the orphaned physical file when the parent folder is not the caller\u2019s', async () => {
    const folderB = seedFolder({ userId: USER_B, name: 'B-folder' });
    const uploaded = seedUploadedFile('orphan.pdf', 'bytes');
    expect(memFs.has(uploaded.path)).toBe(true);
    const res = makeRes();

    await uploadFile(makeReq({ file: uploaded, body: { parentId: String(folderB._id) } }), res);

    expect(status(res)).toBe(404);
    // No record, and the bytes are gone — no orphan left on disk.
    expect(store.filter((r) => r.type === 'file')).toHaveLength(0);
    expect(memFs.has(uploaded.path)).toBe(false);
  });

  it('removes the orphaned physical file when the database write fails', async () => {
    const uploaded = seedUploadedFile('dbfail.pdf', 'bytes');
    const res = makeRes();
    // The fake model's save() appends to `store`, so making that throw is the
    // cleanest way to simulate the database going away AFTER the bytes landed.
    const pushSpy = jest.spyOn(store, 'push').mockImplementation(() => {
      throw new Error('db down');
    });

    await uploadFile(makeReq({ file: uploaded, body: {} }), res);

    pushSpy.mockRestore();
    expect(status(res)).toBe(500);
    // The orphan must not survive a failed database write.
    expect(memFs.has(uploaded.path)).toBe(false);
  });

  it('rejects with 400 when no file reached the handler', async () => {
    const res = makeRes();

    await uploadFile(makeReq({ body: {} }), res);

    expect(status(res)).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6-7: rename
   ═══════════════════════════════════════════════════════════════════════════ */

describe('renameItem', () => {
  it('renames a file without touching the physical filename', async () => {
    const file = seedFile({ name: 'old.pdf' });
    const storedPathBefore = file.storagePath;
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(file._id) }, body: { name: 'new.pdf' } }), res);

    expect(body(res).success).toBe(true);
    expect(data(res).item.name).toBe('new.pdf');
    expect(nameOf(store[0])).toBe('new.pdf');
    // Rename is a pure database operation.
    expect(store[0].storagePath).toBe(storedPathBefore);
  });

  it('renames a folder', async () => {
    const folder = seedFolder({ name: 'Old Folder' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(folder._id) }, body: { name: 'New Folder' } }), res);

    expect(data(res).item.name).toBe('New Folder');
    expect(nameOf(store[0])).toBe('New Folder');
  });

  it('rejects a duplicate name in the same folder with 409', async () => {
    seedFolder({ name: 'Taken' });
    const other = seedFolder({ name: 'Other' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(other._id) }, body: { name: 'Taken' } }), res);

    expect(status(res)).toBe(409);
    expect(nameOf(store[1])).toBe('Other'); // unchanged
  });

  it('treats folders and files as one namespace inside a folder', async () => {
    seedFolder({ name: 'Shared' });
    const file = seedFile({ name: 'file.pdf' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(file._id) }, body: { name: 'Shared' } }), res);

    expect(status(res)).toBe(409);
  });

  it('allows renaming an item to its own name (case change)', async () => {
    const folder = seedFolder({ name: 'Report' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(folder._id) }, body: { name: 'REPORT' } }), res);

    expect(body(res).success).toBe(true);
    expect(nameOf(store[0])).toBe('REPORT');
  });

  it('allows the same name in two different folders', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B' });
    seedFile({ name: 'notes.txt', parentId: String(a._id), path: [String(a._id)] });
    const target = seedFile({ name: 'other.txt', parentId: String(b._id), path: [String(b._id)] });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(target._id) }, body: { name: 'notes.txt' } }), res);

    expect(body(res).success).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8-10: move and cycle detection
   ═══════════════════════════════════════════════════════════════════════════ */

describe('moveItem', () => {
  it('moves a file into a folder and updates its ancestor path', async () => {
    const dest = seedFolder({ name: 'Dest' });
    const file = seedFile({ name: 'a.pdf' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(file._id) }, body: { parentId: String(dest._id) } }), res);

    expect(body(res).success).toBe(true);
    expect(data(res).item.parentId).toBe(String(dest._id));
    expect(data(res).item.path).toEqual([String(dest._id)]);
  });

  it('moves a folder and rewrites every descendant ancestor path', async () => {
    // A/B/C  plus a file inside C, then move A under D.
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const c = seedFolder({ name: 'C', parentId: String(b._id), path: [String(a._id), String(b._id)] });
    const deep = seedFile({
      name: 'deep.pdf',
      parentId: String(c._id),
      path: [String(a._id), String(b._id), String(c._id)]
    });
    const d = seedFolder({ name: 'D' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(d._id) } }), res);

    expect(body(res).success).toBe(true);
    const byId = (id: string) => store.find((r) => String(r._id) === id) as Row;
    expect(byId(String(a._id)).path.map(String)).toEqual([String(d._id)]);
    expect(byId(String(b._id)).path.map(String)).toEqual([String(d._id), String(a._id)]);
    expect(byId(String(c._id)).path.map(String)).toEqual([String(d._id), String(a._id), String(b._id)]);
    expect(byId(String(deep._id)).path.map(String)).toEqual([
      String(d._id),
      String(a._id),
      String(b._id),
      String(c._id)
    ]);
    // Direct parents are untouched inside the subtree.
    expect(String(byId(String(b._id)).parentId)).toBe(String(a._id));
  });

  it('moves an item back to the root', async () => {
    const folder = seedFolder({ name: 'Folder' });
    const file = seedFile({ name: 'f.pdf', parentId: String(folder._id), path: [String(folder._id)] });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(file._id) }, body: { parentId: null } }), res);

    expect(data(res).item.parentId).toBeNull();
    expect(data(res).item.path).toEqual([]);
  });

  it('refuses to move a folder into itself', async () => {
    const a = seedFolder({ name: 'A' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(a._id) } }), res);

    expect(status(res)).toBe(400);
    expect(body(res).message).toMatch(/into itself/i);
  });

  it('refuses to move a folder into its own direct child', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(b._id) } }), res);

    expect(status(res)).toBe(400);
    expect(body(res).message).toMatch(/subfolder/i);
    expect(String(store.find((r) => String(r._id) === String(a._id))!.parentId ?? '')).toBe('');
  });

  it('refuses to move a folder into a deep descendant (A -> C of A/B/C)', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const c = seedFolder({ name: 'C', parentId: String(b._id), path: [String(a._id), String(b._id)] });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(c._id) } }), res);

    expect(status(res)).toBe(400);
    expect(body(res).message).toMatch(/subfolder/i);
    // The tree is untouched.
    expect(store.find((r) => String(r._id) === String(c._id))!.path.map(String)).toEqual([
      String(a._id),
      String(b._id)
    ]);
  });

  it('rejects a move that would collide with an existing name at the destination', async () => {
    const dest = seedFolder({ name: 'Dest' });
    seedFile({ name: 'clash.pdf', parentId: String(dest._id), path: [String(dest._id)] });
    const moving = seedFile({ name: 'clash.pdf' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(moving._id) }, body: { parentId: String(dest._id) } }), res);

    expect(status(res)).toBe(409);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11-16: cross-user isolation
   ═══════════════════════════════════════════════════════════════════════════ */

describe('cross-user isolation — user A must never reach user B', () => {
  it('does not list user B\u2019s items at the root', async () => {
    seedFolder({ userId: USER_B, name: 'B-Secret' });
    seedFolder({ name: 'A-Own' });
    const res = makeRes();

    await listItems(makeReq({ query: {} }), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['A-Own']);
  });

  it('refuses to list inside user B\u2019s folder', async () => {
    const folderB = seedFolder({ userId: USER_B, name: 'B-folder' });
    seedFile({ userId: USER_B, name: 'b-secret.pdf', parentId: String(folderB._id), path: [String(folderB._id)] });
    const res = makeRes();

    await listItems(makeReq({ query: { parentId: String(folderB._id) } }), res);

    expect(status(res)).toBe(404);
    expect(body(res).data).toBeUndefined();
  });

  it('excludes user B\u2019s folders from the move-dialog tree', async () => {
    seedFolder({ userId: USER_B, name: 'B-folder' });
    seedFolder({ name: 'A-folder' });
    const res = makeRes();

    await getTree(makeReq(), res);

    expect(data(res).folders.map((f: any) => f.name)).toEqual(['A-folder']);
  });

  it('refuses to download user B\u2019s file', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf', content: 'B-PRIVATE' });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(fileB._id) } }), res);

    expect(status(res)).toBe(404);
    expect(res.__streamedBody).toBeUndefined();
  });

  it('refuses to rename user B\u2019s file', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(fileB._id) }, body: { name: 'hacked.pdf' } }), res);

    expect(status(res)).toBe(404);
    expect(nameOf(store[0])).toBe('b.pdf');
  });

  it('refuses to delete user B\u2019s file', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf' });
    const res = makeRes();

    await deleteItem(makeReq({ params: { id: String(fileB._id) } }), res);

    expect(status(res)).toBe(404);
    expect(store[0].isDeleted).toBe(false);
  });

  it('refuses to permanently delete user B\u2019s file or remove its bytes', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf', content: 'B-BYTES' });
    const res = makeRes();

    await permanentDeleteItem(makeReq({ params: { id: String(fileB._id) } }), res);

    expect(status(res)).toBe(404);
    expect(store).toHaveLength(1);
    expect([...memFs.values()]).toContain('B-BYTES');
  });

  it('refuses to move user A\u2019s file INTO user B\u2019s folder', async () => {
    const folderB = seedFolder({ userId: USER_B, name: 'B-folder' });
    const fileA = seedFile({ name: 'a.pdf' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(fileA._id) }, body: { parentId: String(folderB._id) } }), res);

    expect(status(res)).toBe(404);
    const row = store.find((r) => String(r._id) === String(fileA._id)) as Row;
    expect(row.parentId).toBeNull();
  });

  it('refuses to move user B\u2019s file into user A\u2019s folder', async () => {
    const folderA = seedFolder({ name: 'A-folder' });
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf' });
    const res = makeRes();

    await moveItem(makeReq({ params: { id: String(fileB._id) }, body: { parentId: String(folderA._id) } }), res);

    expect(status(res)).toBe(404);
  });

  it('refuses to copy user B\u2019s file', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf' });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(fileB._id) }, body: { parentId: null } }), res);

    expect(status(res)).toBe(404);
    expect(store).toHaveLength(1);
  });

  it('refuses to read a breadcrumb for user B\u2019s item', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf' });
    const res = makeRes();

    await getBreadcrumb(makeReq({ params: { id: String(fileB._id) } }), res);

    expect(status(res)).toBe(404);
  });

  it('refuses to restore user B\u2019s trashed item', async () => {
    const fileB = seedFile({ userId: USER_B, name: 'b.pdf', isDeleted: true });
    const res = makeRes();

    await restoreItem(makeReq({ params: { id: String(fileB._id) } }), res);

    expect(status(res)).toBe(404);
    expect(store[0].isDeleted).toBe(true);
  });

  it('keeps user B\u2019s recycle bin out of user A\u2019s', async () => {
    seedFolder({ userId: USER_B, name: 'B-trash', isDeleted: true });
    seedFolder({ name: 'A-trash', isDeleted: true });
    const res = makeRes();

    await listRecycleBin(makeReq(), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['A-trash']);
  });

  it('scopes search to the caller only', async () => {
    seedFile({ userId: USER_B, name: 'secret-report.pdf' });
    seedFile({ name: 'my-report.pdf' });
    const res = makeRes();

    await searchItems(makeReq({ query: { q: 'report' } }), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['my-report.pdf']);
  });

  it('counts only the caller\u2019s bytes in usage', async () => {
    seedFile({ userId: USER_B, name: 'b.bin', size: 900 });
    seedFile({ name: 'a.bin', size: 100 });
    const res = makeRes();

    await getUsage(makeReq(), res);

    expect(data(res).usedBytes).toBe(100);
    expect(data(res).fileCount).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   17: path traversal and name validation
   ═══════════════════════════════════════════════════════════════════════════ */

describe('name validation rejects traversal and control characters', () => {
  const bad: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace only', '   '],
    ['forward slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['parent traversal', '..'],
    ['embedded traversal', '../../etc/passwd'],
    ['windows traversal', '..\\..\\windows'],
    ['dot', '.'],
    ['null byte', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['tab', 'a\tb'],
    ['too long', 'x'.repeat(PERSONAL_FILES_MAX_NAME_LENGTH + 1)]
  ];

  it.each(bad)('rejects %s', (_label, value) => {
    const result = validatePersonalFileName(value);
    expect(result.ok).toBe(false);
  });

  it('accepts an ordinary name and trims it', () => {
    const result = validatePersonalFileName('  Report 2026.pdf  ');
    expect(result).toEqual({ ok: true, value: 'Report 2026.pdf' });
  });

  it('rejects a non-string name', () => {
    expect(validatePersonalFileName(undefined).ok).toBe(false);
    expect(validatePersonalFileName(42).ok).toBe(false);
    expect(validatePersonalFileName({ name: 'x' }).ok).toBe(false);
  });

  it('refuses to create a folder whose name traverses', async () => {
    const res = makeRes();

    await createFolder(makeReq({ body: { name: '../../escape', parentId: null } }), res);

    expect(status(res)).toBe(400);
    expect(store).toHaveLength(0);
  });

  it('refuses to rename to a traversing name', async () => {
    const folder = seedFolder({ name: 'Safe' });
    const res = makeRes();

    await renameItem(makeReq({ params: { id: String(folder._id) }, body: { name: '../evil' } }), res);

    expect(status(res)).toBe(400);
    expect(nameOf(store[0])).toBe('Safe');
  });
});

describe('resolvePersonalFilePath — filesystem containment', () => {
  it('resolves a normal relative stored path inside the storage directory', () => {
    const resolved = resolvePersonalFilePath(`${PERSONAL_FILES_RELATIVE_PREFIX}/abc.pdf`);
    expect(resolved).toBe(path.join(path.resolve(PERSONAL_FILES_DIR), 'abc.pdf'));
  });

  it('resolves a bare filename with no prefix', () => {
    expect(resolvePersonalFilePath('abc.pdf')).toBe(
      path.join(path.resolve(PERSONAL_FILES_DIR), 'abc.pdf')
    );
  });

  const traversals = [
    '../../../etc/passwd',
    `${PERSONAL_FILES_RELATIVE_PREFIX}/../../etc/passwd`,
    'personal-files/../../../../root/.ssh/id_rsa',
    '..',
    '../',
    'a/../../b'
  ];

  it.each(traversals)('refuses traversal %s', (input) => {
    expect(resolvePersonalFilePath(input)).toBeNull();
  });

  it('refuses absolute paths', () => {
    expect(resolvePersonalFilePath('/etc/passwd')).toBeNull();
    expect(resolvePersonalFilePath('C:\\Windows\\System32\\config')).toBeNull();
  });

  it('refuses a null byte, an empty value and non-strings', () => {
    expect(resolvePersonalFilePath('ab\u0000.pdf')).toBeNull();
    expect(resolvePersonalFilePath('')).toBeNull();
    expect(resolvePersonalFilePath(undefined)).toBeNull();
    expect(resolvePersonalFilePath(null)).toBeNull();
    expect(resolvePersonalFilePath(123)).toBeNull();
  });

  it('refuses the storage root itself', () => {
    expect(resolvePersonalFilePath(`${PERSONAL_FILES_RELATIVE_PREFIX}/`)).toBeNull();
  });

  it('serves 404 rather than streaming when a stored path fails resolution', async () => {
    // A tampered/corrupt record whose decrypted path escapes the storage root.
    const file = seedFile({ name: 'evil.pdf', storagePath: '../../../etc/passwd', onDisk: false });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(file._id) } }), res);

    expect(status(res)).toBe(404);
    expect(res.__streamedBody).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   18: quota
   ═══════════════════════════════════════════════════════════════════════════ */

describe('quota enforcement', () => {
  it('reports usage, quota and remaining consistently', async () => {
    seedFile({ name: 'a.bin', size: 400 });
    seedFile({ name: 'b.bin', size: 600 });
    seedFolder({ name: 'F' });
    const res = makeRes();

    await getUsage(makeReq(), res);

    const d = data(res);
    expect(d.usedBytes).toBe(1000);
    expect(d.quotaBytes).toBe(PERSONAL_FILES_QUOTA_BYTES);
    expect(d.remainingBytes).toBe(PERSONAL_FILES_QUOTA_BYTES - 1000);
    expect(d.fileCount).toBe(2);
    expect(d.folderCount).toBe(1);
  });

  it('rejects an upload that would exceed the quota, and keeps no bytes', async () => {
    // Fill the quota to the brim.
    seedFile({ name: 'huge.bin', size: PERSONAL_FILES_QUOTA_BYTES });
    const uploaded = seedUploadedFile('over.pdf', 'one-more-byte');
    const res = makeRes();

    await uploadFile(makeReq({ file: uploaded, body: {} }), res);

    expect(status(res)).toBe(413);
    expect(body(res).message).toMatch(/quota/i);
    expect(store.filter((r) => r.type === 'file')).toHaveLength(1);
    expect(memFs.has(uploaded.path)).toBe(false);
  });

  it('allows an upload that exactly fills the remaining quota', async () => {
    const content = 'abcde';
    seedFile({ name: 'fill.bin', size: PERSONAL_FILES_QUOTA_BYTES - content.length });
    const uploaded = seedUploadedFile('last.pdf', content);
    const res = makeRes();

    await uploadFile(makeReq({ file: uploaded, body: {} }), res);

    expect(status(res)).toBe(201);
  });

  it('counts trashed files toward the quota because their bytes are still on disk', async () => {
    seedFile({ name: 'trashed.bin', size: 700, isDeleted: true });
    const res = makeRes();

    await getUsage(makeReq(), res);

    expect(data(res).usedBytes).toBe(700);
    expect(data(res).trashedBytes).toBe(700);
    expect(data(res).fileCount).toBe(0); // not shown as a live file
  });

  it('refuses a folder copy that would not fit in the remaining quota', async () => {
    const src = seedFolder({ name: 'Src' });
    seedFile({
      name: 'big.bin',
      parentId: String(src._id),
      path: [String(src._id)],
      size: PERSONAL_FILES_QUOTA_BYTES - 10
    });
    const dest = seedFolder({ name: 'Dest' });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(src._id) }, body: { parentId: String(dest._id) } }), res);

    expect(status(res)).toBe(413);
    // Nothing was created.
    expect(store.filter((r) => String(r.parentId) === String(dest._id))).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   19: search
   ═══════════════════════════════════════════════════════════════════════════ */

describe('searchItems', () => {
  it('matches decrypted names case-insensitively as a substring', async () => {
    seedFile({ name: 'Annual REPORT 2026.pdf' });
    seedFolder({ name: 'Reports' });
    seedFile({ name: 'unrelated.txt' });
    const res = makeRes();

    await searchItems(makeReq({ query: { q: 'report' } }), res);

    expect(data(res).items.map((i: any) => i.name).sort()).toEqual([
      'Annual REPORT 2026.pdf',
      'Reports'
    ]);
  });

  it('excludes trashed items', async () => {
    seedFile({ name: 'report-live.pdf' });
    seedFile({ name: 'report-dead.pdf', isDeleted: true });
    const res = makeRes();

    await searchItems(makeReq({ query: { q: 'report' } }), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['report-live.pdf']);
  });

  it('returns an empty list for a blank query without scanning', async () => {
    seedFile({ name: 'anything.pdf' });
    const res = makeRes();

    await searchItems(makeReq({ query: { q: '   ' } }), res);

    expect(data(res).items).toEqual([]);
  });

  it('never returns storagePath in a search result', async () => {
    seedFile({ name: 'report.pdf' });
    const res = makeRes();

    await searchItems(makeReq({ query: { q: 'report' } }), res);

    expect(data(res).items[0].storagePath).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   20: recursive delete, restore, permanent delete
   ═══════════════════════════════════════════════════════════════════════════ */

describe('delete / restore / permanent delete', () => {
  it('soft-deletes a folder and every descendant recursively', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const c = seedFolder({ name: 'C', parentId: String(b._id), path: [String(a._id), String(b._id)] });
    const deep = seedFile({
      name: 'deep.pdf',
      parentId: String(c._id),
      path: [String(a._id), String(b._id), String(c._id)]
    });
    const outside = seedFolder({ name: 'Outside' });
    const res = makeRes();

    await deleteItem(makeReq({ params: { id: String(a._id) } }), res);

    expect(body(res).success).toBe(true);
    expect(data(res).deletedCount).toBe(4);
    for (const id of [a._id, b._id, c._id, deep._id]) {
      expect(store.find((r) => String(r._id) === String(id))!.isDeleted).toBe(true);
    }
    // An unrelated sibling is untouched.
    expect(store.find((r) => String(r._id) === String(outside._id))!.isDeleted).toBe(false);
  });

  it('keeps the physical bytes on a soft delete', async () => {
    const file = seedFile({ name: 'f.pdf', content: 'STILL-HERE' });
    const res = makeRes();

    await deleteItem(makeReq({ params: { id: String(file._id) } }), res);

    expect(store[0].isDeleted).toBe(true);
    expect([...memFs.values()]).toContain('STILL-HERE');
  });

  it('lists a deleted folder once in the recycle bin, not once per descendant', async () => {
    const a = seedFolder({ name: 'A' });
    seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    seedFile({ name: 'f.pdf', parentId: String(a._id), path: [String(a._id)] });
    await deleteItem(makeReq({ params: { id: String(a._id) } }), makeRes());
    const res = makeRes();

    await listRecycleBin(makeReq(), res);

    expect(data(res).items.map((i: any) => i.name)).toEqual(['A']);
  });

  it('restores a folder and its whole subtree', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    await deleteItem(makeReq({ params: { id: String(a._id) } }), makeRes());
    const res = makeRes();

    await restoreItem(makeReq({ params: { id: String(a._id) } }), res);

    expect(data(res).restoredCount).toBe(2);
    expect(store.find((r) => String(r._id) === String(a._id))!.isDeleted).toBe(false);
    expect(store.find((r) => String(r._id) === String(b._id))!.isDeleted).toBe(false);
  });

  it('restores to the root when the original parent is gone', async () => {
    const parent = seedFolder({ name: 'Parent' });
    const child = seedFile({ name: 'c.pdf', parentId: String(parent._id), path: [String(parent._id)] });
    // Trash only the child, then hard-remove the parent record.
    await deleteItem(makeReq({ params: { id: String(child._id) } }), makeRes());
    store.splice(store.indexOf(parent), 1);
    const res = makeRes();

    await restoreItem(makeReq({ params: { id: String(child._id) } }), res);

    expect(body(res).success).toBe(true);
    const row = store.find((r) => String(r._id) === String(child._id)) as Row;
    expect(row.parentId).toBeNull();
    expect(row.path).toEqual([]);
  });

  it('renames on restore when the original name is now taken', async () => {
    const file = seedFile({ name: 'dup.pdf' });
    await deleteItem(makeReq({ params: { id: String(file._id) } }), makeRes());
    seedFile({ name: 'dup.pdf' }); // a new file claimed the name meanwhile
    const res = makeRes();

    await restoreItem(makeReq({ params: { id: String(file._id) } }), res);

    expect(body(res).success).toBe(true);
    expect(nameOf(store.find((r) => String(r._id) === String(file._id)) as Row)).toBe('dup (2).pdf');
  });

  it('permanently deletes a folder subtree and its physical files', async () => {
    const a = seedFolder({ name: 'A' });
    const f1 = seedFile({ name: 'f1.pdf', parentId: String(a._id), path: [String(a._id)], content: 'ONE' });
    const f2 = seedFile({ name: 'f2.pdf', parentId: String(a._id), path: [String(a._id)], content: 'TWO' });
    const res = makeRes();

    await permanentDeleteItem(makeReq({ params: { id: String(a._id) } }), res);

    expect(data(res).deletedCount).toBe(3);
    expect(store).toHaveLength(0);
    expect([...memFs.values()]).not.toContain('ONE');
    expect([...memFs.values()]).not.toContain('TWO');
    expect(String(f1._id)).not.toBe(String(f2._id));
  });

  it('permanently deletes successfully even when the physical file is already missing', async () => {
    const file = seedFile({ name: 'ghost.pdf', onDisk: false });
    const res = makeRes();

    await permanentDeleteItem(makeReq({ params: { id: String(file._id) } }), res);

    // A missing file must never fail the request — the database is authoritative.
    expect(body(res).success).toBe(true);
    expect(store).toHaveLength(0);
  });

  it('rejects a malformed id rather than throwing', async () => {
    const res = makeRes();

    await deleteItem(makeReq({ params: { id: 'not-an-object-id' } }), res);

    expect(status(res)).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   21-23: download behaviour and content safety
   ═══════════════════════════════════════════════════════════════════════════ */

describe('downloadFile — content type and disposition', () => {
  it('streams a PDF inline with its real content type when asked', async () => {
    const file = seedFile({ name: 'doc.pdf', mimeType: 'application/pdf', content: 'PDFBYTES' });
    const res = makeRes();

    await downloadFile(
      makeReq({ params: { id: String(file._id) }, query: { disposition: 'inline' } }),
      res
    );

    expect(res.__headers['Content-Type']).toBe('application/pdf');
    expect(res.__headers['Content-Disposition']).toContain('inline');
    expect(res.__headers['Content-Disposition']).toContain('doc.pdf');
    expect(res.__streamedBody).toBe('PDFBYTES');
  });

  it('streams an image inline with its real content type', async () => {
    const file = seedFile({ name: 'p.png', mimeType: 'image/png', content: 'PNG' });
    const res = makeRes();

    await downloadFile(
      makeReq({ params: { id: String(file._id) }, query: { disposition: 'inline' } }),
      res
    );

    expect(res.__headers['Content-Type']).toBe('image/png');
    expect(res.__headers['Content-Disposition']).toContain('inline');
  });

  it('defaults to an attachment download with a neutral content type', async () => {
    const file = seedFile({ name: 'doc.pdf', mimeType: 'application/pdf' });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(file._id) } }), res);

    expect(res.__headers['Content-Type']).toBe('application/octet-stream');
    expect(res.__headers['Content-Disposition']).toContain('attachment');
  });

  it.each([
    ['text/html', 'page.html'],
    ['image/svg+xml', 'vector.svg'],
    ['application/javascript', 'script.js'],
    ['text/javascript', 'script2.js'],
    ['application/xml', 'data.xml']
  ])('forces %s to download even when inline is requested', async (mimeType, name) => {
    const file = seedFile({ name, mimeType, content: '<script>alert(1)</script>' });
    const res = makeRes();

    await downloadFile(
      makeReq({ params: { id: String(file._id) }, query: { disposition: 'inline' } }),
      res
    );

    // Never rendered in the app's origin: neither an inline disposition nor the
    // active content type is echoed back.
    expect(res.__headers['Content-Disposition']).toContain('attachment');
    expect(res.__headers['Content-Disposition']).not.toContain('inline');
    expect(res.__headers['Content-Type']).toBe('application/octet-stream');
  });

  it('always sets the hardening headers', async () => {
    const file = seedFile({ name: 'doc.pdf', mimeType: 'application/pdf' });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(file._id) } }), res);

    expect(res.__headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.__headers['X-Frame-Options']).toBe('DENY');
    expect(res.__headers['Cache-Control']).toBe('private, no-store');
    expect(res.__headers['Content-Security-Policy']).toContain("default-src 'none'");
  });

  it('sanitises a hostile filename out of the Content-Disposition header', async () => {
    // A stored name with a quote and CRLF must not be able to break the header.
    const id = newId();
    store.push({
      _id: id,
      userId: USER_A,
      type: 'file',
      name: encryptField('ev"il\r\nX-Injected: yes.pdf', id) as string,
      parentId: null,
      path: [],
      storagePath: encryptField(`${PERSONAL_FILES_RELATIVE_PREFIX}/ok.bin`, id) as string,
      mimeType: 'application/pdf',
      size: 3,
      isDeleted: false
    });
    memFs.set(path.join(PERSONAL_FILES_DIR, 'ok.bin'), 'abc');
    const res = makeRes();

    await downloadFile(makeReq({ params: { id } }), res);

    const disposition = res.__headers['Content-Disposition'];
    // The property that matters is that the quoted token cannot be escaped and no
    // new header line can be started. Residual inert text inside the quotes is
    // harmless, so it is not asserted against.
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    // Exactly two quotes remain: the pair delimiting the filename token.
    expect((disposition.match(/"/g) || []).length).toBe(2);
    expect(disposition).toBe('attachment; filename="ev_ilX-Injected: yes.pdf"');
  });

  it('returns 404, not a crash, when the physical file is missing', async () => {
    const file = seedFile({ name: 'ghost.pdf', onDisk: false });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(file._id) } }), res);

    expect(status(res)).toBe(404);
    expect(body(res).message).toMatch(/no longer available/i);
  });

  it('refuses to download a trashed file', async () => {
    const file = seedFile({ name: 'trashed.pdf', isDeleted: true });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(file._id) } }), res);

    expect(status(res)).toBe(404);
  });

  it('refuses to download a folder', async () => {
    const folder = seedFolder({ name: 'A' });
    const res = makeRes();

    await downloadFile(makeReq({ params: { id: String(folder._id) } }), res);

    expect(status(res)).toBe(404);
  });
});

describe('mime safety helpers', () => {
  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/xml'])(
    'treats %s as forced-download',
    (mime) => {
      expect(isForcedDownloadMime(mime)).toBe(true);
      expect(isInlinePreviewableMime(mime)).toBe(false);
    }
  );

  it.each(['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv', 'audio/mpeg', 'video/mp4'])(
    'treats %s as inline-previewable',
    (mime) => {
      expect(isInlinePreviewableMime(mime)).toBe(true);
      expect(isForcedDownloadMime(mime)).toBe(false);
    }
  );

  it('ignores codec parameters when classifying', () => {
    expect(isInlinePreviewableMime('audio/webm;codecs=opus')).toBe(true);
    expect(isForcedDownloadMime('text/html; charset=utf-8')).toBe(true);
  });

  it('treats a missing mime type as unsafe to render', () => {
    expect(isForcedDownloadMime(undefined)).toBe(true);
    expect(isInlinePreviewableMime(undefined)).toBe(false);
  });

  it('sanitises disposition filenames and never returns an empty one', () => {
    expect(sanitizeDispositionFilename('a"b\\c/d.pdf')).toBe('a_b_c_d.pdf');
    // Control characters are stripped, so an all-control name has nothing
    // left and falls back to a safe default.
    expect(sanitizeDispositionFilename('\u0000\u0001')).toBe('download');
    expect(sanitizeDispositionFilename('re\r\nport.pdf')).toBe('report.pdf');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   24: bulk operations
   ═══════════════════════════════════════════════════════════════════════════ */

describe('bulkOperation', () => {
  it('deletes several owned items and reports the counts', async () => {
    const f1 = seedFile({ name: 'a.pdf' });
    const f2 = seedFile({ name: 'b.pdf' });
    const res = makeRes();

    await bulkOperation(
      makeReq({ body: { operation: 'delete', ids: [String(f1._id), String(f2._id)] } }),
      res
    );

    expect(data(res).successCount).toBe(2);
    expect(data(res).failureCount).toBe(0);
    expect(store.every((r) => r.isDeleted)).toBe(true);
  });

  it('skips another user\u2019s items while still processing the caller\u2019s', async () => {
    const mine = seedFile({ name: 'mine.pdf' });
    const theirs = seedFile({ userId: USER_B, name: 'theirs.pdf' });
    const res = makeRes();

    await bulkOperation(
      makeReq({ body: { operation: 'delete', ids: [String(mine._id), String(theirs._id)] } }),
      res
    );

    expect(data(res).succeeded).toEqual([String(mine._id)]);
    expect(data(res).failed).toHaveLength(1);
    expect(data(res).failed[0].id).toBe(String(theirs._id));
    // The other user's document is untouched.
    expect(store.find((r) => String(r._id) === String(theirs._id))!.isDeleted).toBe(false);
  });

  it('refuses a bulk move into another user\u2019s folder for every item', async () => {
    const folderB = seedFolder({ userId: USER_B, name: 'B' });
    const f1 = seedFile({ name: 'a.pdf' });
    const f2 = seedFile({ name: 'b.pdf' });
    const res = makeRes();

    await bulkOperation(
      makeReq({
        body: { operation: 'move', ids: [String(f1._id), String(f2._id)], parentId: String(folderB._id) }
      }),
      res
    );

    expect(data(res).successCount).toBe(0);
    expect(data(res).failureCount).toBe(2);
    expect(store.filter((r) => r.userId === USER_A).every((r) => r.parentId === null)).toBe(true);
  });

  it('applies the same cycle rule in bulk as for a single move', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const res = makeRes();

    await bulkOperation(
      makeReq({ body: { operation: 'move', ids: [String(a._id)], parentId: String(b._id) } }),
      res
    );

    expect(data(res).failureCount).toBe(1);
    expect(data(res).failed[0].message).toMatch(/subfolder/i);
  });

  it('rejects an unknown operation', async () => {
    const res = makeRes();

    await bulkOperation(makeReq({ body: { operation: 'chmod', ids: ['x'] } }), res);

    expect(status(res)).toBe(400);
  });

  it('rejects an empty or non-array id list', async () => {
    const res1 = makeRes();
    await bulkOperation(makeReq({ body: { operation: 'delete', ids: [] } }), res1);
    expect(status(res1)).toBe(400);

    const res2 = makeRes();
    await bulkOperation(makeReq({ body: { operation: 'delete', ids: 'all' } }), res2);
    expect(status(res2)).toBe(400);
  });

  it('rejects an over-large batch', async () => {
    const res = makeRes();
    const ids = Array.from({ length: 500 }, () => newId());

    await bulkOperation(makeReq({ body: { operation: 'delete', ids } }), res);

    expect(status(res)).toBe(400);
    expect(body(res).message).toMatch(/may not exceed/i);
  });

  it('requires authentication', async () => {
    const res = makeRes();

    await bulkOperation(makeReq({ user: null, body: { operation: 'delete', ids: ['x'] } }), res);

    expect(status(res)).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   copy and breadcrumb
   ═══════════════════════════════════════════════════════════════════════════ */

describe('copyItem', () => {
  it('copies a file to a new record with its OWN new physical file', async () => {
    const dest = seedFolder({ name: 'Dest' });
    const file = seedFile({ name: 'orig.pdf', content: 'SHARED-BYTES' });
    const originalPath = decryptField(file.storagePath, String(file._id)) as string;
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(file._id) }, body: { parentId: String(dest._id) } }), res);

    expect(status(res)).toBe(201);
    const copyRow = store.find(
      (r) => r.type === 'file' && String(r._id) !== String(file._id)
    ) as Row;
    const copyPath = decryptField(copyRow.storagePath, String(copyRow._id)) as string;
    // Distinct physical files — never a shared path.
    expect(copyPath).not.toBe(originalPath);
    expect(copyPath.startsWith(`${PERSONAL_FILES_RELATIVE_PREFIX}/`)).toBe(true);
    // Same bytes, both present.
    expect([...memFs.values()].filter((v) => v === 'SHARED-BYTES')).toHaveLength(2);
    // Logical name preserved.
    expect(nameOf(copyRow)).toBe('orig.pdf');
  });

  it('suffixes the copy when copying into the folder that already holds the original', async () => {
    const file = seedFile({ name: 'orig.pdf' });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(file._id) }, body: { parentId: null } }), res);

    expect(status(res)).toBe(201);
    expect(data(res).item.name).toBe('orig (2).pdf');
  });

  it('recursively copies a folder tree, re-parenting every level', async () => {
    const src = seedFolder({ name: 'Src' });
    const sub = seedFolder({ name: 'Sub', parentId: String(src._id), path: [String(src._id)] });
    seedFile({
      name: 'inner.pdf',
      parentId: String(sub._id),
      path: [String(src._id), String(sub._id)],
      content: 'INNER'
    });
    const dest = seedFolder({ name: 'Dest' });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(src._id) }, body: { parentId: String(dest._id) } }), res);

    expect(status(res)).toBe(201);
    const newRootId = data(res).item._id;
    const newRoot = store.find((r) => String(r._id) === newRootId) as Row;
    expect(newRoot.path.map(String)).toEqual([String(dest._id)]);

    const newSub = store.find(
      (r) => r.type === 'folder' && String(r.parentId) === newRootId
    ) as Row;
    expect(nameOf(newSub)).toBe('Sub');
    expect(newSub.path.map(String)).toEqual([String(dest._id), newRootId]);

    const newFile = store.find(
      (r) => r.type === 'file' && String(r.parentId) === String(newSub._id)
    ) as Row;
    expect(nameOf(newFile)).toBe('inner.pdf');
    expect(newFile.path.map(String)).toEqual([String(dest._id), newRootId, String(newSub._id)]);
    // Both the original and the copy have their own bytes.
    expect([...memFs.values()].filter((v) => v === 'INNER')).toHaveLength(2);
  });

  it('refuses to copy a folder into itself', async () => {
    const a = seedFolder({ name: 'A' });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(a._id) } }), res);

    expect(status(res)).toBe(400);
    expect(body(res).message).toMatch(/into itself/i);
  });

  it('refuses to copy a folder into its own descendant', async () => {
    const a = seedFolder({ name: 'A' });
    const b = seedFolder({ name: 'B', parentId: String(a._id), path: [String(a._id)] });
    const res = makeRes();

    await copyItem(makeReq({ params: { id: String(a._id) }, body: { parentId: String(b._id) } }), res);

    expect(status(res)).toBe(400);
  });
});

describe('getBreadcrumb', () => {
  it('returns the ancestor chain root-most first, ending with the item', async () => {
    const docs = seedFolder({ name: 'Documents' });
    const work = seedFolder({ name: 'Work', parentId: String(docs._id), path: [String(docs._id)] });
    const file = seedFile({
      name: 'Report.pdf',
      parentId: String(work._id),
      path: [String(docs._id), String(work._id)]
    });
    const res = makeRes();

    await getBreadcrumb(makeReq({ params: { id: String(file._id) } }), res);

    expect(data(res).breadcrumb.map((b: any) => b.name)).toEqual([
      'Documents',
      'Work',
      'Report.pdf'
    ]);
  });

  it('returns just the item at the root', async () => {
    const folder = seedFolder({ name: 'Top' });
    const res = makeRes();

    await getBreadcrumb(makeReq({ params: { id: String(folder._id) } }), res);

    expect(data(res).breadcrumb.map((b: any) => b.name)).toEqual(['Top']);
  });

  it('rejects a malformed id', async () => {
    const res = makeRes();

    await getBreadcrumb(makeReq({ params: { id: 'nope' } }), res);

    expect(status(res)).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   /bulk module permission gate
   ═══════════════════════════════════════════════════════════════════════════ */

describe('bulkOperation - module permission gate', () => {
  // /bulk carries its operation in the request BODY, so no route-level middleware
  // can gate it. These tests prove the controller applies exactly the permission
  // the equivalent single-item route requires, so /bulk can never be used as a way
  // around a revoked permission.

  it.each([
    ['move', 'edit'],
    ['copy', 'create'],
    ['delete', 'delete'],
    ['restore', 'delete'],
    ['permanentDelete', 'delete']
  ])('refuses %s with 403 when %s is revoked', async (operation, revoked) => {
    const file = seedFile({ name: 'a.pdf' });
    const perms: Record<string, boolean> = { view: true, create: true, edit: true, delete: true };
    perms[revoked] = false;
    setPersonalFilesPermissions(perms);
    const res = makeRes();

    await bulkOperation(
      makeReq({ body: { operation, ids: [String(file._id)], parentId: null } }),
      res
    );

    expect(status(res)).toBe(403);
    expect(body(res).success).toBe(false);
    // Nothing happened to the document.
    expect(store[0].isDeleted).toBe(false);
    expect(store).toHaveLength(1);
  });

  it.each([
    ['move', 'create'],
    ['copy', 'edit'],
    ['delete', 'edit']
  ])('still allows %s when only the unrelated %s permission is revoked', async (operation, revoked) => {
    const dest = seedFolder({ name: 'Dest' });
    const file = seedFile({ name: 'a.pdf' });
    const perms: Record<string, boolean> = { view: true, create: true, edit: true, delete: true };
    perms[revoked] = false;
    setPersonalFilesPermissions(perms);
    const res = makeRes();

    await bulkOperation(
      makeReq({ body: { operation, ids: [String(file._id)], parentId: String(dest._id) } }),
      res
    );

    expect(status(res)).not.toBe(403);
    expect(data(res).successCount).toBe(1);
  });

  it('permits every operation when the module is absent (backward compatibility)', async () => {
    const file = seedFile({ name: 'a.pdf' });
    setPersonalFilesPermissions(undefined);
    const res = makeRes();

    await bulkOperation(makeReq({ body: { operation: 'delete', ids: [String(file._id)] } }), res);

    expect(status(res)).not.toBe(403);
    expect(data(res).successCount).toBe(1);
  });

  it('lets a superadmin through the gate without a permission lookup', async () => {
    const file = seedFile({ name: 'a.pdf' });
    setPersonalFilesPermissions({ view: false, create: false, edit: false, delete: false });
    const res = makeRes();

    await bulkOperation(
      makeReq({
        user: { _id: USER_A, email: 'a@example.com', displayName: 'A', role: 'superadmin' },
        body: { operation: 'delete', ids: [String(file._id)] }
      }),
      res
    );

    expect(status(res)).not.toBe(403);
    expect(data(res).successCount).toBe(1);
  });

  it('the superadmin fast path is still NOT an ownership bypass', async () => {
    // The critical invariant: bypassing the FEATURE gate must never bypass
    // ownership. A superadmin bulk-deleting another user's file must fail.
    const theirs = seedFile({ userId: USER_B, name: 'theirs.pdf' });
    const res = makeRes();

    await bulkOperation(
      makeReq({
        user: { _id: USER_A, email: 'a@example.com', displayName: 'A', role: 'superadmin' },
        body: { operation: 'delete', ids: [String(theirs._id)] }
      }),
      res
    );

    expect(data(res).successCount).toBe(0);
    expect(data(res).failureCount).toBe(1);
    // Still owned, still not deleted.
    expect(store[0].userId).toBe(USER_B);
    expect(store[0].isDeleted).toBe(false);
  });

  it('fails closed if the permission lookup throws', async () => {
    const file = seedFile({ name: 'a.pdf' });
    UserMock.findById = jest.fn(() => ({
      select: jest.fn().mockRejectedValue(new Error('db down'))
    }));
    const res = makeRes();

    await bulkOperation(makeReq({ body: { operation: 'delete', ids: [String(file._id)] } }), res);

    expect(status(res)).toBe(403);
    expect(store[0].isDeleted).toBe(false);
  });

  it('rejects an unknown operation before any permission lookup', async () => {
    const res = makeRes();

    await bulkOperation(makeReq({ body: { operation: 'chmod', ids: ['x'] } }), res);

    expect(status(res)).toBe(400);
    expect(UserMock.findById).not.toHaveBeenCalled();
  });
});
