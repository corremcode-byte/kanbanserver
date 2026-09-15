/**
 * Shared Files: GLOBAL visibility, uploadedBy attribution, folder-tree integrity,
 * storage safety, permission enforcement on /bulk, and concurrent-mutation safety.
 *
 * Same in-memory-fake approach as personalFilesController.test.ts: the properties
 * worth protecting are behavioural (User B must see User A's upload; a folder
 * cannot end up inside itself; a permanently deleted file must not be
 * downloadable), and a call-assertion test cannot demonstrate any of them.
 *
 * The single most important property of this module is that NO query is ever
 * scoped by the caller. The fake model enforces that structurally: `userId` is
 * NOT a supported filter key, so any attempt to filter by owner throws and fails
 * the test loudly.
 *
 * Field encryption is NOT mocked - the real utility runs.
 *
 * Actor model: USER_A and USER_B are two ordinary users. Both hold view; the
 * tests vary create/edit/delete per case. Nothing either of them does is private
 * from the other.
 */

import mongoose from 'mongoose';

// ── In-memory filesystem ─────────────────────────────────────────────────────
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

// ── In-memory SharedFile model ───────────────────────────────────────────────

type Row = Record<string, any>;
const store: Row[] = [];

function newId(): string {
  return new mongoose.Types.ObjectId().toString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// `userId` is DELIBERATELY absent. Shared Files must never filter by owner; if the
// controller ever tries, matches() throws and the test fails.
const SUPPORTED_KEYS = new Set(['_id', 'type', 'isDeleted', 'parentId', 'path', 'uploadedBy']);

function matches(row: Row, filter: Row): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(`fake SharedFile model: unsupported filter key "${key}" - Shared Files must be global`);
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

const SharedFileMock: any = function SharedFileCtor(this: any, data: Row) {
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

SharedFileMock.find = jest.fn((filter: Row = {}) => chainable(store.filter((r) => matches(r, filter))));
SharedFileMock.findOne = jest.fn((filter: Row = {}) => {
  const row = store.find((r) => matches(r, filter));
  const chain: any = {
    lean: jest.fn(async () => (row ? clone(row) : null)),
    select: jest.fn(() => chain)
  };
  return chain;
});
SharedFileMock.updateOne = jest.fn(async (filter: Row, update: Row) => {
  const row = store.find((r) => matches(r, filter));
  if (!row) return { matchedCount: 0, modifiedCount: 0 };
  applyUpdate(row, update);
  return { matchedCount: 1, modifiedCount: 1 };
});
SharedFileMock.updateMany = jest.fn(async (filter: Row, update: Row) => {
  const rows = store.filter((r) => matches(r, filter));
  rows.forEach((r) => applyUpdate(r, update));
  return { matchedCount: rows.length, modifiedCount: rows.length };
});
SharedFileMock.bulkWrite = jest.fn(async (ops: any[]) => {
  for (const op of ops) {
    const { filter, update } = op.updateOne;
    const row = store.find((r) => matches(r, filter));
    if (row) applyUpdate(row, update);
  }
  return { modifiedCount: ops.length };
});
SharedFileMock.deleteMany = jest.fn(async (filter: Row) => {
  const doomed = store.filter((r) => matches(r, filter));
  for (const d of doomed) store.splice(store.indexOf(d), 1);
  return { deletedCount: doomed.length };
});
SharedFileMock.countDocuments = jest.fn(async (filter: Row) => store.filter((r) => matches(r, filter)).length);
SharedFileMock.aggregate = jest.fn(async (pipeline: any[]) => {
  const match = pipeline[0].$match;
  if ('userId' in match) throw new Error('usage aggregation must be GLOBAL - no userId');
  const rows = store.filter((r) => r.type === match.type);
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

// ── In-memory User model ─────────────────────────────────────────────────────
const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const USER_GONE = '507f1f77bcf86cd799439033';

const users: Row[] = [
  { _id: USER_A, displayName: 'Akhilesh' },
  { _id: USER_B, displayName: 'Bhavana' }
];

/** Per-user sharedFiles permissions, read by bulkOperation. */
const permissionsByUser: Record<string, Row> = {};

const UserMock: any = {
  find: jest.fn((filter: Row = {}) => {
    const ids = (filter._id?.$in || []).map(String);
    return chainable(users.filter((u) => ids.includes(String(u._id))));
  }),
  findById: jest.fn((id: string) => ({
    select: jest.fn().mockResolvedValue({
      permissions: { modules: { sharedFiles: permissionsByUser[String(id)] } }
    })
  }))
};

/** A separate PersonalFile mock that must NEVER be touched by this controller. */
const PersonalFileMock: any = new Proxy(
  {},
  {
    get: (_t, prop: string) => {
      if (prop === 'then') return undefined;
      return jest.fn(() => {
        throw new Error(`sharedFilesController touched PersonalFile.${String(prop)} - modules must be isolated`);
      });
    }
  }
);

jest.mock('../../models', () => ({
  SharedFile: SharedFileMock,
  PersonalFile: PersonalFileMock,
  User: UserMock
}));

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
  validateSharedFileName,
  resolveSharedFilePath,
  isForcedDownloadMime,
  isInlinePreviewableMime,
  sanitizeDispositionFilename,
  BULK_OPERATION_PERMISSION
} from '../sharedFilesController';
import { encryptField, decryptField } from '../../utils/fieldEncryption';
import {
  SHARED_FILES_DIR,
  SHARED_FILES_RELATIVE_PREFIX,
  SHARED_FILES_QUOTA_BYTES,
  SHARED_FILES_MAX_NAME_LENGTH
} from '../../config/sharedFiles';

import path from 'path';

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
    user: { _id: USER_A, email: 'a@example.com', displayName: 'Akhilesh', role: 'member' },
    params: {},
    body: {},
    query: {},
    ...overrides
  } as any;
}

function asUser(id: string, overrides: any = {}) {
  const u = users.find((x) => String(x._id) === id);
  return makeReq({
    user: { _id: id, email: `${id}@example.com`, displayName: u?.displayName || 'Ghost', role: 'member' },
    ...overrides
  });
}

/** Seeds a row directly into the store, encrypting the way the controller does. */
function seed(data: Row): Row {
  const id = data._id || newId();
  const row: Row = {
    _id: id,
    isDeleted: false,
    path: [],
    parentId: null,
    uploadedBy: USER_A,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data
  };
  if (row.name) row.name = encryptField(row.name, id);
  if (row.storagePath) row.storagePath = encryptField(row.storagePath, id);
  if (row.originalName) row.originalName = encryptField(row.originalName, id);
  store.push(row);
  return row;
}

function seedFile(name: string, opts: Row = {}): Row {
  const filename = `${Date.now()}-${newId()}.bin`;
  const relative = `${SHARED_FILES_RELATIVE_PREFIX}/${filename}`;
  const body = opts.body ?? 'file-bytes';
  memFs.set(path.join(SHARED_FILES_DIR, filename), body);
  const { body: _b, ...rest } = opts;
  return seed({
    type: 'file',
    name,
    storagePath: relative,
    originalName: name,
    mimeType: opts.mimeType || 'application/pdf',
    size: Buffer.byteLength(body),
    ...rest
  });
}

function seedFolder(name: string, opts: Row = {}): Row {
  return seed({ type: 'folder', name, ...opts });
}

function rowById(id: string): Row | undefined {
  return store.find((r) => String(r._id) === String(id));
}

function nameOf(row: Row): string {
  return decryptField(row.name, String(row._id));
}

beforeEach(() => {
  store.length = 0;
  memFs.clear();
  permissionsByUser[USER_A] = { view: true, create: true, edit: true, delete: true };
  permissionsByUser[USER_B] = { view: true, create: true, edit: true, delete: true };
});

/* ═══════════════════════════════════════════════════════════════════════════
   GLOBAL VISIBILITY - the defining property of the module
   ═══════════════════════════════════════════════════════════════════════════ */

describe('global visibility', () => {
  it('User B sees the EXACT SAME file User A uploaded (one record, not a copy)', async () => {
    const uploaded = seedFile('company-policy.pdf', { uploadedBy: USER_A });

    const resA = makeRes();
    await listItems(asUser(USER_A), resA);
    const resB = makeRes();
    await listItems(asUser(USER_B), resB);

    expect(resA.__body.data.items.map((i: any) => i._id)).toEqual([String(uploaded._id)]);
    expect(resB.__body.data.items.map((i: any) => i._id)).toEqual([String(uploaded._id)]);
    expect(resB.__body.data.items[0].name).toBe('company-policy.pdf');
    expect(store.length).toBe(1);
  });

  it('a listing mixes uploads from every user in the same folder', async () => {
    seedFile('from-a.pdf', { uploadedBy: USER_A });
    seedFile('from-b.pdf', { uploadedBy: USER_B });

    const res = makeRes();
    await listItems(asUser(USER_B), res);

    expect(res.__body.data.items.map((i: any) => i.name).sort()).toEqual(['from-a.pdf', 'from-b.pdf']);
  });

  it('User B can download User A’s file with view alone', async () => {
    const file = seedFile('shared.pdf', { uploadedBy: USER_A, body: 'PDF-BYTES' });
    permissionsByUser[USER_B] = { view: true, create: false, edit: false, delete: false };

    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) } }), res);

    expect(res.__status).toBeUndefined();
    expect(res.__streamedBody).toBe('PDF-BYTES');
  });

  it('User B can browse into User A’s folder and see the breadcrumb', async () => {
    const folder = seedFolder('Policies', { uploadedBy: USER_A });
    const file = seedFile('hr.pdf', { uploadedBy: USER_A, parentId: folder._id, path: [folder._id] });

    const list = makeRes();
    await listItems(asUser(USER_B, { query: { parentId: String(folder._id) } }), list);
    expect(list.__body.data.items.map((i: any) => i._id)).toEqual([String(file._id)]);

    const crumb = makeRes();
    await getBreadcrumb(asUser(USER_B, { params: { id: String(file._id) } }), crumb);
    expect(crumb.__body.data.breadcrumb.map((c: any) => c.name)).toEqual(['Policies', 'hr.pdf']);
  });

  it('search is global: User B finds User A’s upload', async () => {
    seedFile('financial-report.pdf', { uploadedBy: USER_A });
    seedFile('unrelated.txt', { uploadedBy: USER_B });

    const res = makeRes();
    await searchItems(asUser(USER_B, { query: { q: 'financial' } }), res);

    expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['financial-report.pdf']);
    expect(res.__body.data.items[0].uploadedBy.displayName).toBe('Akhilesh');
  });

  it('the folder tree is global', async () => {
    seedFolder('A-folder', { uploadedBy: USER_A });
    seedFolder('B-folder', { uploadedBy: USER_B });

    const res = makeRes();
    await getTree(asUser(USER_B), res);

    expect(res.__body.data.folders.map((f: any) => f.name).sort()).toEqual(['A-folder', 'B-folder']);
  });

  it('User B can rename, move and delete User A’s upload when permitted', async () => {
    const folder = seedFolder('Dest', { uploadedBy: USER_B });
    const file = seedFile('a.pdf', { uploadedBy: USER_A });

    const rename = makeRes();
    await renameItem(asUser(USER_B, { params: { id: String(file._id) }, body: { name: 'renamed.pdf' } }), rename);
    expect(rename.__status).toBe(200);
    expect(nameOf(rowById(String(file._id))!)).toBe('renamed.pdf');

    const move = makeRes();
    await moveItem(asUser(USER_B, { params: { id: String(file._id) }, body: { parentId: String(folder._id) } }), move);
    expect(move.__status).toBe(200);
    expect(String(rowById(String(file._id))!.parentId)).toBe(String(folder._id));

    const del = makeRes();
    await deleteItem(asUser(USER_B, { params: { id: String(file._id) } }), del);
    expect(del.__status).toBe(200);
    expect(rowById(String(file._id))!.isDeleted).toBe(true);
    // Attribution of the deletion is recorded, but the ORIGINAL uploader stays.
    expect(String(rowById(String(file._id))!.deletedBy)).toBe(USER_B);
    expect(String(rowById(String(file._id))!.uploadedBy)).toBe(USER_A);
  });

  it('never filters any query by the caller (structural tripwire)', async () => {
    // Every handler is exercised; if any of them added `userId` to a filter the
    // fake model would throw and the handler would answer 500.
    const folder = seedFolder('F');
    const file = seedFile('x.pdf', { parentId: folder._id, path: [folder._id] });
    const calls: Array<[any, any]> = [
      [listItems, asUser(USER_B)],
      [getTree, asUser(USER_B)],
      [getBreadcrumb, asUser(USER_B, { params: { id: String(file._id) } })],
      [searchItems, asUser(USER_B, { query: { q: 'x' } })],
      [getUsage, asUser(USER_B)],
      [listRecycleBin, asUser(USER_B)],
      [downloadFile, asUser(USER_B, { params: { id: String(file._id) } })]
    ];
    for (const [handler, req] of calls) {
      const res = makeRes();
      await handler(req, res);
      expect(res.__status).not.toBe(500);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   uploadedBy - recorded and resolved, never a filter
   ═══════════════════════════════════════════════════════════════════════════ */

describe('uploadedBy attribution', () => {
  function fakeUpload(name: string, body = 'bytes') {
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, body);
    return { filename, originalname: name, mimetype: 'application/pdf', size: body.length, path: abs };
  }

  it('records the uploader on upload and returns their display name', async () => {
    const res = makeRes();
    await uploadFile(asUser(USER_B, { file: fakeUpload('report.pdf') }), res);

    expect(res.__status).toBe(201);
    expect(res.__body.data.item.uploadedBy).toEqual({ _id: USER_B, displayName: 'Bhavana' });
    expect(String(store[0].uploadedBy)).toBe(USER_B);
  });

  it('records the creator on folder creation', async () => {
    const res = makeRes();
    await createFolder(asUser(USER_B, { body: { name: 'Team' } }), res);

    expect(res.__status).toBe(201);
    expect(res.__body.data.item.uploadedBy).toEqual({ _id: USER_B, displayName: 'Bhavana' });
  });

  it('resolves display names in one batched lookup for a listing', async () => {
    seedFile('a.pdf', { uploadedBy: USER_A });
    seedFile('b.pdf', { uploadedBy: USER_B });
    seedFile('c.pdf', { uploadedBy: USER_A });
    (UserMock.find as jest.Mock).mockClear();

    const res = makeRes();
    await listItems(asUser(USER_B), res);

    expect(UserMock.find).toHaveBeenCalledTimes(1);
    const byName = Object.fromEntries(res.__body.data.items.map((i: any) => [i.name, i.uploadedBy.displayName]));
    expect(byName).toEqual({ 'a.pdf': 'Akhilesh', 'b.pdf': 'Bhavana', 'c.pdf': 'Akhilesh' });
  });

  it('shows "Unknown user" for an uploader who no longer exists, without failing', async () => {
    seedFile('orphaned.pdf', { uploadedBy: USER_GONE });

    const res = makeRes();
    await listItems(asUser(USER_B), res);

    expect(res.__status).toBe(200);
    expect(res.__body.data.items[0].uploadedBy).toEqual({ _id: USER_GONE, displayName: 'Unknown user' });
  });

  it('exposes only _id and displayName of the uploader', async () => {
    seedFile('a.pdf', { uploadedBy: USER_A });
    const res = makeRes();
    await listItems(asUser(USER_B), res);
    expect(Object.keys(res.__body.data.items[0].uploadedBy).sort()).toEqual(['_id', 'displayName']);
  });

  it('attributes a copy to the COPIER, and the copy is visible to the original uploader', async () => {
    const original = seedFile('a.pdf', { uploadedBy: USER_A });

    const res = makeRes();
    await copyItem(asUser(USER_B, { params: { id: String(original._id) }, body: { parentId: null } }), res);

    expect(res.__status).toBe(201);
    expect(res.__body.data.item.uploadedBy).toEqual({ _id: USER_B, displayName: 'Bhavana' });
    const copy = rowById(res.__body.data.item._id)!;
    expect(String(copy.uploadedBy)).toBe(USER_B);
    // Original untouched.
    expect(String(rowById(String(original._id))!.uploadedBy)).toBe(USER_A);

    const listA = makeRes();
    await listItems(asUser(USER_A), listA);
    expect(listA.__body.data.items.length).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Global quota and recycle bin
   ═══════════════════════════════════════════════════════════════════════════ */

describe('global quota', () => {
  it('reports the SAME usage to every user', async () => {
    seedFile('a.pdf', { uploadedBy: USER_A, size: 500, body: 'x'.repeat(500) });
    seedFile('b.pdf', { uploadedBy: USER_B, size: 300, body: 'x'.repeat(300) });

    const resA = makeRes();
    await getUsage(asUser(USER_A), resA);
    const resB = makeRes();
    await getUsage(asUser(USER_B), resB);

    expect(resA.__body.data.usedBytes).toBe(800);
    expect(resB.__body.data.usedBytes).toBe(800);
    expect(resB.__body.data.quotaBytes).toBe(SHARED_FILES_QUOTA_BYTES);
  });

  it('counts trashed files toward usage, reported separately', async () => {
    seedFile('live.pdf', { size: 100, body: 'x'.repeat(100) });
    seedFile('binned.pdf', { size: 50, body: 'x'.repeat(50), isDeleted: true, deletedAt: new Date() });

    const res = makeRes();
    await getUsage(asUser(USER_B), res);

    expect(res.__body.data.usedBytes).toBe(150);
    expect(res.__body.data.trashedBytes).toBe(50);
    expect(res.__body.data.fileCount).toBe(1);
  });

  it('rejects an upload by User B when User A’s uploads already fill the repository', async () => {
    seedFile('huge.bin', { uploadedBy: USER_A, size: SHARED_FILES_QUOTA_BYTES - 10, body: 'placeholder' });
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'x'.repeat(100));

    const res = makeRes();
    await uploadFile(
      asUser(USER_B, { file: { filename, originalname: 'one-more.pdf', mimetype: 'application/pdf', size: 100, path: abs } }),
      res
    );

    expect(res.__status).toBe(413);
    // The rejected upload's bytes are cleaned up.
    expect(memFs.has(abs)).toBe(false);
    expect(store.length).toBe(1);
  });

  it('rejects a copy that would exceed the global quota', async () => {
    const big = seedFile('big.bin', { size: SHARED_FILES_QUOTA_BYTES - 5, body: 'small-on-disk' });
    const res = makeRes();
    await copyItem(asUser(USER_B, { params: { id: String(big._id) }, body: { parentId: null } }), res);
    expect(res.__status).toBe(413);
    expect(store.length).toBe(1);
  });
});

describe('global recycle bin', () => {
  it('User A deletes, User B sees it in the bin and can restore it for everyone', async () => {
    const file = seedFile('policy.pdf', { uploadedBy: USER_A });

    await deleteItem(asUser(USER_A, { params: { id: String(file._id) } }), makeRes());

    const listA = makeRes();
    await listItems(asUser(USER_A), listA);
    expect(listA.__body.data.items).toEqual([]);

    const bin = makeRes();
    await listRecycleBin(asUser(USER_B), bin);
    expect(bin.__body.data.items.map((i: any) => i._id)).toEqual([String(file._id)]);

    const restore = makeRes();
    await restoreItem(asUser(USER_B, { params: { id: String(file._id) } }), restore);
    expect(restore.__status).toBe(200);

    const listB = makeRes();
    await listItems(asUser(USER_B), listB);
    expect(listB.__body.data.items.map((i: any) => i._id)).toEqual([String(file._id)]);
    const again = makeRes();
    await listItems(asUser(USER_A), again);
    expect(again.__body.data.items.map((i: any) => i._id)).toEqual([String(file._id)]);
  });

  it('deleting a folder soft-deletes its whole subtree and shows it once in the bin', async () => {
    const folder = seedFolder('Root');
    const sub = seedFolder('Sub', { parentId: folder._id, path: [folder._id] });
    const f1 = seedFile('a.pdf', { parentId: folder._id, path: [folder._id] });
    const f2 = seedFile('b.pdf', { parentId: sub._id, path: [folder._id, sub._id] });

    const res = makeRes();
    await deleteItem(asUser(USER_B, { params: { id: String(folder._id) } }), res);

    expect(res.__body.data.deletedCount).toBe(4);
    for (const r of [folder, sub, f1, f2]) expect(rowById(String(r._id))!.isDeleted).toBe(true);

    const bin = makeRes();
    await listRecycleBin(asUser(USER_A), bin);
    expect(bin.__body.data.items.map((i: any) => i._id)).toEqual([String(folder._id)]);
  });

  it('restores a folder subtree, and falls back to root when the parent is still trashed', async () => {
    const parent = seedFolder('Parent');
    const child = seedFolder('Child', { parentId: parent._id, path: [parent._id] });
    const file = seedFile('c.pdf', { parentId: child._id, path: [parent._id, child._id] });

    await deleteItem(asUser(USER_A, { params: { id: String(child._id) } }), makeRes());
    await deleteItem(asUser(USER_B, { params: { id: String(parent._id) } }), makeRes());

    const res = makeRes();
    await restoreItem(asUser(USER_B, { params: { id: String(child._id) } }), res);

    expect(res.__body.data.restoredCount).toBe(2);
    const restoredChild = rowById(String(child._id))!;
    expect(restoredChild.isDeleted).toBe(false);
    expect(restoredChild.parentId).toBeNull();
    expect(restoredChild.path).toEqual([]);
    const restoredFile = rowById(String(file._id))!;
    expect(restoredFile.isDeleted).toBe(false);
    expect(restoredFile.path.map(String)).toEqual([String(child._id)]);
    // The parent stays in the bin.
    expect(rowById(String(parent._id))!.isDeleted).toBe(true);
  });

  it('permanent delete removes the records AND the physical files', async () => {
    const folder = seedFolder('Del');
    const file = seedFile('gone.pdf', { parentId: folder._id, path: [folder._id] });
    const abs = path.join(SHARED_FILES_DIR, decryptField(file.storagePath, String(file._id)).split('/')[1]);
    expect(memFs.has(abs)).toBe(true);

    const res = makeRes();
    await permanentDeleteItem(asUser(USER_B, { params: { id: String(folder._id) } }), res);

    expect(res.__body.data.deletedCount).toBe(2);
    expect(store.length).toBe(0);
    expect(memFs.has(abs)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Concurrent mutation safety
   ═══════════════════════════════════════════════════════════════════════════ */

describe('concurrent mutation safety', () => {
  it('User B downloading a file User A permanently deleted gets a clean 404', async () => {
    const file = seedFile('race.pdf');
    await permanentDeleteItem(asUser(USER_A, { params: { id: String(file._id) } }), makeRes());

    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) } }), res);

    expect(res.__status).toBe(404);
  });

  it('a file whose bytes vanished from disk answers 404, not 500', async () => {
    const file = seedFile('missing.pdf');
    memFs.clear();

    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) } }), res);

    expect(res.__status).toBe(404);
    expect(res.__body.message).toMatch(/no longer available/);
  });

  it('renaming an item another user just deleted is refused', async () => {
    const file = seedFile('x.pdf');
    await deleteItem(asUser(USER_A, { params: { id: String(file._id) } }), makeRes());

    const res = makeRes();
    await renameItem(asUser(USER_B, { params: { id: String(file._id) }, body: { name: 'y.pdf' } }), res);

    expect(res.__status).toBe(404);
    expect(nameOf(rowById(String(file._id))!)).toBe('x.pdf');
  });

  it('rename detects a delete that lands between its read and its write', async () => {
    const file = seedFile('x.pdf');
    // Simulate the race: the write's state-qualified filter finds nothing.
    const original = SharedFileMock.updateOne;
    SharedFileMock.updateOne = jest.fn(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    try {
      const res = makeRes();
      await renameItem(asUser(USER_B, { params: { id: String(file._id) }, body: { name: 'y.pdf' } }), res);
      expect(res.__status).toBe(409);
      expect(res.__body.message).toMatch(/changed by another user/);
    } finally {
      SharedFileMock.updateOne = original;
    }
  });

  it('moving into a folder another user deleted is refused', async () => {
    const dest = seedFolder('Dest');
    const file = seedFile('x.pdf');
    await deleteItem(asUser(USER_A, { params: { id: String(dest._id) } }), makeRes());

    const res = makeRes();
    await moveItem(asUser(USER_B, { params: { id: String(file._id) }, body: { parentId: String(dest._id) } }), res);

    expect(res.__status).toBe(404);
    expect(rowById(String(file._id))!.parentId).toBeNull();
  });

  it('restoring an item someone else already restored is a clean 404', async () => {
    const file = seedFile('x.pdf');
    await deleteItem(asUser(USER_A, { params: { id: String(file._id) } }), makeRes());
    await restoreItem(asUser(USER_B, { params: { id: String(file._id) } }), makeRes());

    const res = makeRes();
    await restoreItem(asUser(USER_A, { params: { id: String(file._id) } }), res);
    expect(res.__status).toBe(404);
  });

  it('deleting an item someone else already deleted is a clean 404', async () => {
    const file = seedFile('x.pdf');
    await deleteItem(asUser(USER_A, { params: { id: String(file._id) } }), makeRes());

    const res = makeRes();
    await deleteItem(asUser(USER_B, { params: { id: String(file._id) } }), res);
    expect(res.__status).toBe(404);
  });

  it('a failed upload (DB write throws) leaves no orphan on disk', async () => {
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'bytes');
    // The fake document's save() persists by pushing into the store; make that
    // write fail exactly once, as a database write-concern failure would.
    const pushSpy = jest.spyOn(store, 'push').mockImplementationOnce(() => {
      throw new Error('write concern failed');
    });

    const res = makeRes();
    await uploadFile(
      asUser(USER_A, { file: { filename, originalname: 'a.pdf', mimetype: 'application/pdf', size: 5, path: abs } }),
      res
    );

    pushSpy.mockRestore();
    expect(res.__status).toBe(500);
    expect(memFs.has(abs)).toBe(false);
    expect(store.length).toBe(0);
  });

  it('a failed copy rolls back every record and file it created', async () => {
    const folder = seedFolder('Src');
    seedFile('a.pdf', { parentId: folder._id, path: [folder._id] });
    const b = seedFile('b.pdf', { parentId: folder._id, path: [folder._id] });
    // Make b's bytes unreadable so its copy throws mid-way.
    memFs.delete(path.join(SHARED_FILES_DIR, decryptField(b.storagePath, String(b._id)).split('/')[1]));
    const before = store.length;
    const filesBefore = memFs.size;

    const res = makeRes();
    await copyItem(asUser(USER_B, { params: { id: String(folder._id) }, body: { parentId: null } }), res);

    expect(res.__status).toBe(500);
    expect(res.__body.message).toMatch(/no partial copy/);
    expect(store.length).toBe(before);
    expect(memFs.size).toBe(filesBefore);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Tree integrity
   ═══════════════════════════════════════════════════════════════════════════ */

describe('folder tree integrity', () => {
  it('refuses to move a folder into itself', async () => {
    const folder = seedFolder('F');
    const res = makeRes();
    await moveItem(asUser(USER_A, { params: { id: String(folder._id) }, body: { parentId: String(folder._id) } }), res);
    expect(res.__status).toBe(400);
  });

  it('refuses to move a folder into its own descendant', async () => {
    const a = seedFolder('A');
    const b = seedFolder('B', { parentId: a._id, path: [a._id] });
    const res = makeRes();
    await moveItem(asUser(USER_B, { params: { id: String(a._id) }, body: { parentId: String(b._id) } }), res);
    expect(res.__status).toBe(400);
    expect(rowById(String(a._id))!.parentId).toBeNull();
  });

  it('moving a folder rewrites every descendant’s ancestor path', async () => {
    const a = seedFolder('A');
    const b = seedFolder('B', { parentId: a._id, path: [a._id] });
    const f = seedFile('f.pdf', { parentId: b._id, path: [a._id, b._id] });
    const dest = seedFolder('Dest');

    const res = makeRes();
    await moveItem(asUser(USER_B, { params: { id: String(a._id) }, body: { parentId: String(dest._id) } }), res);

    expect(res.__status).toBe(200);
    expect(rowById(String(a._id))!.path.map(String)).toEqual([String(dest._id)]);
    expect(rowById(String(b._id))!.path.map(String)).toEqual([String(dest._id), String(a._id)]);
    expect(rowById(String(f._id))!.path.map(String)).toEqual([String(dest._id), String(a._id), String(b._id)]);
  });

  it('rejects a duplicate name in the same folder (case-insensitive), across uploaders', async () => {
    seedFile('Report.pdf', { uploadedBy: USER_A });
    const res = makeRes();
    await createFolder(asUser(USER_B, { body: { name: 'report.pdf' } }), res);
    expect(res.__status).toBe(409);
  });

  it('auto-suffixes an uploaded duplicate rather than failing', async () => {
    seedFile('report.pdf', { uploadedBy: USER_A });
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'bytes');

    const res = makeRes();
    await uploadFile(
      asUser(USER_B, { file: { filename, originalname: 'report.pdf', mimetype: 'application/pdf', size: 5, path: abs } }),
      res
    );

    expect(res.__status).toBe(201);
    expect(res.__body.data.item.name).toBe('report (2).pdf');
  });

  it('recursively copies a folder with fresh ids and fresh physical files', async () => {
    const src = seedFolder('Src');
    const sub = seedFolder('Sub', { parentId: src._id, path: [src._id] });
    const file = seedFile('deep.pdf', { parentId: sub._id, path: [src._id, sub._id], body: 'DEEP' });
    const filesBefore = memFs.size;

    const res = makeRes();
    await copyItem(asUser(USER_B, { params: { id: String(src._id) }, body: { parentId: null } }), res);

    expect(res.__status).toBe(201);
    expect(res.__body.data.item.name).toBe('Src (2)');
    expect(store.length).toBe(6);
    expect(memFs.size).toBe(filesBefore + 1);
    const copiedFile = store.find((r) => r.type === 'file' && String(r._id) !== String(file._id))!;
    expect(decryptField(copiedFile.storagePath, String(copiedFile._id))).not.toBe(
      decryptField(file.storagePath, String(file._id))
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Bulk operations enforce per-operation permissions
   ═══════════════════════════════════════════════════════════════════════════ */

describe('bulk operations', () => {
  it('maps every operation to the same permission its single-item route requires', () => {
    expect(BULK_OPERATION_PERMISSION).toEqual({
      move: 'edit',
      copy: 'create',
      delete: 'delete',
      restore: 'delete',
      permanentDelete: 'delete'
    });
  });

  it.each([
    ['move', { view: true, create: true, edit: false, delete: true }],
    ['copy', { view: true, create: false, edit: true, delete: true }],
    ['delete', { view: true, create: true, edit: true, delete: false }],
    ['restore', { view: true, create: true, edit: true, delete: false }],
    ['permanentDelete', { view: true, create: true, edit: true, delete: false }]
  ])('denies bulk %s with 403 when the matching flag is false, touching nothing', async (operation, perms) => {
    const file = seedFile('x.pdf', { isDeleted: operation === 'restore' });
    const snapshot = clone(store);
    permissionsByUser[USER_B] = perms;

    const res = makeRes();
    await bulkOperation(asUser(USER_B, { body: { operation, ids: [String(file._id)], parentId: null } }), res);

    expect(res.__status).toBe(403);
    expect(clone(store)).toEqual(snapshot);
  });

  it('denies bulk when the sharedFiles module is absent (closed default)', async () => {
    const file = seedFile('x.pdf');
    delete permissionsByUser[USER_B];

    const res = makeRes();
    await bulkOperation(asUser(USER_B, { body: { operation: 'delete', ids: [String(file._id)] } }), res);

    expect(res.__status).toBe(403);
    expect(rowById(String(file._id))!.isDeleted).toBe(false);
  });

  it('a user with only view can do nothing via bulk', async () => {
    const file = seedFile('x.pdf');
    permissionsByUser[USER_B] = { view: true, create: false, edit: false, delete: false };
    for (const operation of ['move', 'copy', 'delete', 'restore', 'permanentDelete']) {
      const res = makeRes();
      await bulkOperation(asUser(USER_B, { body: { operation, ids: [String(file._id)], parentId: null } }), res);
      expect(res.__status).toBe(403);
    }
    expect(store.length).toBe(1);
  });

  it('bulk delete by User B removes User A’s items, per item, with failures isolated', async () => {
    const a = seedFile('a.pdf', { uploadedBy: USER_A });
    const b = seedFile('b.pdf', { uploadedBy: USER_A });
    const bogus = newId();

    const res = makeRes();
    await bulkOperation(asUser(USER_B, { body: { operation: 'delete', ids: [String(a._id), bogus, String(b._id)] } }), res);

    expect(res.__body.data.successCount).toBe(2);
    expect(res.__body.data.failed).toEqual([{ id: bogus, message: 'Item not found' }]);
    expect(rowById(String(a._id))!.isDeleted).toBe(true);
    expect(rowById(String(b._id))!.isDeleted).toBe(true);
  });

  it('rejects an unknown operation and an empty id list', async () => {
    const r1 = makeRes();
    await bulkOperation(asUser(USER_A, { body: { operation: 'nuke', ids: ['x'] } }), r1);
    expect(r1.__status).toBe(400);
    const r2 = makeRes();
    await bulkOperation(asUser(USER_A, { body: { operation: 'delete', ids: [] } }), r2);
    expect(r2.__status).toBe(400);
  });

  it('a superadmin passes the bulk gate without a permission lookup', async () => {
    const file = seedFile('x.pdf');
    delete permissionsByUser[USER_B];
    const res = makeRes();
    await bulkOperation(
      makeReq({ user: { _id: USER_B, role: 'superadmin', displayName: 'Root' }, body: { operation: 'delete', ids: [String(file._id)] } }),
      res
    );
    expect(res.__status).toBe(200);
    expect(rowById(String(file._id))!.isDeleted).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Storage safety
   ═══════════════════════════════════════════════════════════════════════════ */

describe('storage path safety', () => {
  it.each([
    ['absolute posix', '/etc/passwd'],
    ['absolute windows', 'C:\\Windows\\system.ini'],
    ['traversal', 'shared-files/../../.env'],
    ['traversal without prefix', '../.env'],
    ['null byte', 'shared-files/ok.pdf\u0000.txt'],
    ['empty', ''],
    ['prefix only', 'shared-files/'],
    ['not a string', 42 as any],
    ['the storage root itself', 'shared-files/..']
  ])('rejects %s', (_label, input) => {
    expect(resolveSharedFilePath(input)).toBeNull();
  });

  it('resolves a legitimate relative path strictly inside SHARED_FILES_DIR', () => {
    const abs = resolveSharedFilePath('shared-files/123-abc.pdf');
    expect(abs).toBe(path.join(SHARED_FILES_DIR, '123-abc.pdf'));
    expect(abs!.startsWith(path.resolve(SHARED_FILES_DIR) + path.sep)).toBe(true);
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    const sibling = path.resolve(SHARED_FILES_DIR + '-evil', 'x.pdf');
    const rel = path.relative(SHARED_FILES_DIR, sibling).replace(/\\/g, '/');
    expect(resolveSharedFilePath(rel)).toBeNull();
  });

  it('never serves a record whose stored path fails safe resolution', async () => {
    const file = seed({ type: 'file', name: 'evil.pdf', storagePath: '../../.env', mimeType: 'application/pdf', size: 1 });
    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) } }), res);
    expect(res.__status).toBe(404);
    expect(res.__streamedFrom).toBeUndefined();
  });

  it('never resolves against the personal-files directory', () => {
    const abs = resolveSharedFilePath('shared-files/x.pdf')!;
    expect(abs).not.toMatch(/personal-files/);
    expect(resolveSharedFilePath('personal-files/x.pdf')).toBe(path.join(SHARED_FILES_DIR, 'personal-files', 'x.pdf'));
    // (a foreign prefix is treated as a plain relative name under the SHARED dir,
    // so it can never reach a personal file)
  });
});

describe('name validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['dot-dot', 'a..b'],
    ['dot', '.'],
    ['control char', 'a\u0001b'],
    ['null byte', 'a\u0000b'],
    ['too long', 'x'.repeat(SHARED_FILES_MAX_NAME_LENGTH + 1)],
    ['not a string', 7 as any]
  ])('rejects %s', (_label, input) => {
    expect(validateSharedFileName(input).ok).toBe(false);
  });

  it('trims and accepts a normal name', () => {
    expect(validateSharedFileName('  Quarterly Report.pdf ')).toEqual({ ok: true, value: 'Quarterly Report.pdf' });
  });

  it('an unsafe originalname on upload is rejected and the bytes discarded', async () => {
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'bytes');

    const res = makeRes();
    await uploadFile(
      asUser(USER_A, { file: { filename, originalname: '../../etc/passwd', mimetype: 'application/pdf', size: 5, path: abs }, body: { name: '../evil' } }),
      res
    );

    expect(res.__status).toBe(400);
    expect(memFs.has(abs)).toBe(false);
    expect(store.length).toBe(0);
  });

  it('the physical filename never derives from the client name', async () => {
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'bytes');

    const res = makeRes();
    await uploadFile(
      asUser(USER_A, { file: { filename, originalname: 'my report.pdf', mimetype: 'application/pdf', size: 5, path: abs } }),
      res
    );

    expect(res.__status).toBe(201);
    const stored = decryptField(store[0].storagePath, String(store[0]._id));
    expect(stored).toBe(`${SHARED_FILES_RELATIVE_PREFIX}/${filename}`);
    expect(stored).not.toContain('my report');
    expect(path.isAbsolute(stored)).toBe(false);
  });
});

describe('download headers and dangerous types', () => {
  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/xml', 'text/xml'])(
    'forces %s to download as octet-stream even when inline is requested',
    async (mimeType) => {
      const file = seedFile('active.txt', { mimeType });
      const res = makeRes();
      await downloadFile(asUser(USER_B, { params: { id: String(file._id) }, query: { disposition: 'inline' } }), res);
      expect(res.__headers['Content-Type']).toBe('application/octet-stream');
      expect(res.__headers['Content-Disposition']).toMatch(/^attachment;/);
    }
  );

  it('serves a PDF inline when asked, with private no-store and sandbox headers', async () => {
    const file = seedFile('doc.pdf', { mimeType: 'application/pdf' });
    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) }, query: { disposition: 'inline' } }), res);
    expect(res.__headers['Content-Type']).toBe('application/pdf');
    expect(res.__headers['Content-Disposition']).toBe('inline; filename="doc.pdf"');
    expect(res.__headers['Cache-Control']).toBe('private, no-store');
    expect(res.__headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.__headers['X-Frame-Options']).toBe('DENY');
    expect(res.__headers['Content-Security-Policy']).toBe("default-src 'none'; sandbox");
  });

  it('defaults to attachment when no disposition is given', async () => {
    const file = seedFile('doc.pdf');
    const res = makeRes();
    await downloadFile(asUser(USER_B, { params: { id: String(file._id) } }), res);
    expect(res.__headers['Content-Disposition']).toMatch(/^attachment;/);
  });

  it('sanitises the disposition filename', () => {
    expect(sanitizeDispositionFilename('a"b\\c/d\r\ne.pdf')).toBe('a_b_c_de.pdf');
    expect(sanitizeDispositionFilename('\r\n')).toBe('download');
  });

  it('classifies preview safety the same way as the download policy', () => {
    expect(isForcedDownloadMime('text/html')).toBe(true);
    expect(isForcedDownloadMime(undefined)).toBe(true);
    expect(isInlinePreviewableMime('image/svg+xml')).toBe(false);
    expect(isInlinePreviewableMime('application/pdf')).toBe(true);
    expect(isInlinePreviewableMime('image/png')).toBe(true);
    expect(isInlinePreviewableMime('application/zip')).toBe(false);
  });

  it('does not serve a folder or a trashed file', async () => {
    const folder = seedFolder('F');
    const binned = seedFile('b.pdf', { isDeleted: true, deletedAt: new Date() });
    for (const id of [String(folder._id), String(binned._id)]) {
      const res = makeRes();
      await downloadFile(asUser(USER_B, { params: { id } }), res);
      expect(res.__status).toBe(404);
    }
  });

  it('rejects an unauthenticated download without touching the database', async () => {
    const file = seedFile('doc.pdf');
    (SharedFileMock.findOne as jest.Mock).mockClear();
    const res = makeRes();
    await downloadFile(makeReq({ user: null, params: { id: String(file._id) } }), res);
    expect(res.__status).toBe(401);
    expect(SharedFileMock.findOne).not.toHaveBeenCalled();
  });
});

describe('input validation', () => {
  it('rejects a malformed id on every per-item handler', async () => {
    const handlers: any[] = [getBreadcrumb, renameItem, moveItem, copyItem, deleteItem, restoreItem, permanentDeleteItem, downloadFile];
    for (const handler of handlers) {
      const res = makeRes();
      await handler(asUser(USER_A, { params: { id: 'not-an-id' }, body: { name: 'x', parentId: null } }), res);
      expect(res.__status).toBe(400);
    }
  });

  it('rejects a malformed parentId on list, create, upload, move, copy', async () => {
    const r1 = makeRes();
    await listItems(asUser(USER_A, { query: { parentId: 'nope' } }), r1);
    expect(r1.__status).toBe(400);
    const r2 = makeRes();
    await createFolder(asUser(USER_A, { body: { name: 'F', parentId: 'nope' } }), r2);
    expect(r2.__status).toBe(400);
  });

  it('treats null, "null", "root" and "" all as the root', async () => {
    seedFile('r.pdf');
    for (const parentId of [null, 'null', 'root', '', undefined]) {
      const res = makeRes();
      await listItems(asUser(USER_B, { query: { parentId } }), res);
      expect(res.__body.data.items.length).toBe(1);
    }
  });

  it('every handler rejects an unauthenticated request with 401', async () => {
    const handlers: any[] = [listItems, getTree, getBreadcrumb, createFolder, uploadFile, renameItem, moveItem, copyItem, deleteItem, restoreItem, permanentDeleteItem, listRecycleBin, bulkOperation, searchItems, getUsage, downloadFile];
    for (const handler of handlers) {
      const res = makeRes();
      await handler(makeReq({ user: null, params: { id: newId() } }), res);
      expect(res.__status).toBe(401);
    }
  });
});

describe('encryption round trip', () => {
  it('stores name/storagePath/originalName encrypted with the document’s own id and returns them decrypted', async () => {
    const filename = `${Date.now()}-${newId()}.pdf`;
    const abs = path.join(SHARED_FILES_DIR, filename);
    memFs.set(abs, 'bytes');
    const res = makeRes();
    await uploadFile(asUser(USER_A, { file: { filename, originalname: 'secret plan.pdf', mimetype: 'application/pdf', size: 5, path: abs } }), res);

    const row = store[0];
    expect(row.name).not.toBe('secret plan.pdf');
    expect(row.storagePath).not.toContain('shared-files/');
    expect(decryptField(row.name, String(row._id))).toBe('secret plan.pdf');
    expect(res.__body.data.item.name).toBe('secret plan.pdf');
    expect(res.__body.data.item.storagePath).toBeUndefined();
  });
});
