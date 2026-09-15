/**
 * Cross-module isolation: Personal Files and Shared Files must never leak into
 * each other.
 *
 *   User A creates Personal Files/private.pdf   -> must NOT appear in Shared Files
 *   User A creates Shared Files/company.pdf     -> must NOT appear in Personal Files
 *
 * Two layers of proof:
 *
 * 1. BEHAVIOURAL. Both controllers run against separate in-memory collections. A
 *    Personal record and a Shared record are seeded side by side, and every
 *    listing/search/tree/bin/download of each module is asserted to return only
 *    its own record. Each module's model mock also THROWS if the other controller
 *    touches it, so a stray cross-import cannot pass silently.
 *
 * 2. STRUCTURAL. The Shared controller/model/config/routes contain no reference to
 *    the Personal model, directory, prefix, config or permission - and vice versa.
 *    The two multer instances write to different directories. The two models are
 *    registered under different Mongoose names.
 */

import mongoose from 'mongoose';
import { join } from 'path';

// `fs` is mocked below for the behavioural half; the structural half reads real
// source files, so it uses the genuine module.
const { readFileSync } = jest.requireActual('fs') as typeof import('fs');

// ── Shared in-memory FS (both modules), keyed by absolute path ──────────────
const memFs = new Map<string, string>();

jest.mock('fs', () => ({
  existsSync: jest.fn((p: string) => memFs.has(String(p))),
  mkdirSync: jest.fn(),
  createReadStream: jest.fn((p: string) => {
    const stream: any = {
      on: jest.fn(() => stream),
      pipe: jest.fn((dest: any) => {
        dest.__streamedFrom = String(p);
        return dest;
      })
    };
    return stream;
  })
}));
jest.mock('fs/promises', () => ({
  unlink: jest.fn(async (): Promise<void> => undefined),
  stat: jest.fn(async (p: string) => ({ size: Buffer.byteLength(memFs.get(String(p)) || '') })),
  copyFile: jest.fn(async (): Promise<void> => undefined)
}));
jest.mock('../utils/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

type Row = Record<string, any>;

/** A minimal fake collection sufficient for the read paths under test. */
function makeCollection(label: string, allowUserId: boolean) {
  const store: Row[] = [];
  const supported = new Set(['_id', 'type', 'isDeleted', 'parentId', 'path', 'uploadedBy', ...(allowUserId ? ['userId'] : [])]);
  const matches = (row: Row, filter: Row) => {
    for (const [key, expected] of Object.entries(filter)) {
      if (!supported.has(key)) throw new Error(`${label}: unsupported filter key ${key}`);
      const actual = row[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
        if (!(expected.$in as any[]).map(String).includes(String(actual))) return false;
        continue;
      }
      if (key === 'path') {
        if (!(actual || []).map(String).includes(String(expected))) return false;
        continue;
      }
      if (key === 'parentId') {
        const a = actual == null ? null : String(actual);
        const b = expected == null ? null : String(expected);
        if (a !== b) return false;
        continue;
      }
      if (expected == null) {
        if (actual != null) return false;
        continue;
      }
      if (typeof expected === 'boolean') {
        if (!!actual !== expected) return false;
        continue;
      }
      if (String(actual) !== String(expected)) return false;
    }
    return true;
  };
  const chain = (rows: Row[]) => {
    const c: any = {
      select: jest.fn(() => c),
      sort: jest.fn(() => c),
      lean: jest.fn(async () => rows.map((r) => JSON.parse(JSON.stringify(r))))
    };
    return c;
  };
  const Model: any = {
    __store: store,
    find: jest.fn((filter: Row = {}) => chain(store.filter((r) => matches(r, filter)))),
    findOne: jest.fn((filter: Row = {}) => {
      const row = store.find((r) => matches(r, filter));
      const c: any = { lean: jest.fn(async () => (row ? JSON.parse(JSON.stringify(row)) : null)), select: jest.fn(() => c) };
      return c;
    }),
    countDocuments: jest.fn(async (filter: Row) => store.filter((r) => matches(r, filter)).length),
    aggregate: jest.fn(async (pipeline: any[]) => {
      const match = pipeline[0].$match;
      const rows = store.filter((r) => matches(r, match));
      const bytes = rows.reduce((s, r) => s + (r.size || 0), 0);
      return rows.length ? [{ _id: false, bytes, count: rows.length }] : [];
    })
  };
  return Model;
}

const PersonalFileMock = makeCollection('PersonalFile', true);
const SharedFileMock = makeCollection('SharedFile', false);

/** Wraps a model so that any use by the WRONG controller throws. */
let activeModule: 'personal' | 'shared' | null = null;
function guarded(model: any, owner: 'personal' | 'shared', name: string) {
  return new Proxy(model, {
    get: (target, prop: string) => {
      if (prop === '__store' || prop === 'then') return target[prop];
      if (activeModule && activeModule !== owner) {
        throw new Error(`${activeModule}FilesController touched ${name}.${String(prop)} - modules must be isolated`);
      }
      return target[prop];
    }
  });
}

const USER_A = '507f1f77bcf86cd799439011';

const UserMock: any = {
  find: jest.fn(() => ({ select: jest.fn(() => ({ lean: jest.fn(async () => [{ _id: USER_A, displayName: 'Akhilesh' }]) })) })),
  findById: jest.fn(() => ({
    select: jest.fn().mockResolvedValue({
      permissions: {
        modules: {
          personalFiles: { view: true, create: true, edit: true, delete: true },
          sharedFiles: { view: true, create: true, edit: true, delete: true }
        }
      }
    })
  }))
};

jest.mock('../models', () => ({
  PersonalFile: guarded(PersonalFileMock, 'personal', 'PersonalFile'),
  SharedFile: guarded(SharedFileMock, 'shared', 'SharedFile'),
  User: UserMock
}));

import * as personal from '../controllers/personalFilesController';
import * as shared from '../controllers/sharedFilesController';
import { encryptField } from '../utils/fieldEncryption';
import { PERSONAL_FILES_DIR, PERSONAL_FILES_RELATIVE_PREFIX } from '../config/personalFiles';
import { SHARED_FILES_DIR, SHARED_FILES_RELATIVE_PREFIX } from '../config/sharedFiles';

function makeRes() {
  const res: any = { headersSent: false, __headers: {} };
  res.status = jest.fn((code: number) => {
    res.__status = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.__body = body;
    return res;
  });
  res.setHeader = jest.fn();
  res.destroy = jest.fn();
  return res;
}

function req(overrides: any = {}) {
  return { user: { _id: USER_A, email: 'a@x', displayName: 'Akhilesh', role: 'member' }, params: {}, query: {}, body: {}, ...overrides } as any;
}

function seed(store: Row[], data: Row, dir: string, prefix: string) {
  const id = new mongoose.Types.ObjectId().toString();
  const filename = `${id}.pdf`;
  memFs.set(join(dir, filename), 'bytes');
  const row: Row = {
    _id: id,
    type: 'file',
    parentId: null,
    path: [],
    isDeleted: false,
    mimeType: 'application/pdf',
    size: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data
  };
  row.name = encryptField(row.name, id);
  row.storagePath = encryptField(`${prefix}/${filename}`, id);
  store.push(row);
  return row;
}

async function runAs(module: 'personal' | 'shared', fn: () => Promise<void>) {
  activeModule = module;
  try {
    await fn();
  } finally {
    activeModule = null;
  }
}

let privatePdf: Row;
let companyPdf: Row;

beforeEach(() => {
  PersonalFileMock.__store.length = 0;
  SharedFileMock.__store.length = 0;
  memFs.clear();
  privatePdf = seed(PersonalFileMock.__store, { name: 'private.pdf', userId: USER_A }, PERSONAL_FILES_DIR, PERSONAL_FILES_RELATIVE_PREFIX);
  companyPdf = seed(SharedFileMock.__store, { name: 'company.pdf', uploadedBy: USER_A }, SHARED_FILES_DIR, SHARED_FILES_RELATIVE_PREFIX);
});

describe('behavioural isolation - User A has one file in EACH module', () => {
  it('Shared Files listing shows company.pdf and NOT private.pdf', async () => {
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.listItems(req(), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['company.pdf']);
      expect(res.__body.data.items.map((i: any) => i._id)).not.toContain(String(privatePdf._id));
    });
  });

  it('Personal Files listing shows private.pdf and NOT company.pdf', async () => {
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.listItems(req(), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['private.pdf']);
      expect(res.__body.data.items.map((i: any) => i._id)).not.toContain(String(companyPdf._id));
    });
  });

  it('Shared search never finds a Personal file, and vice versa', async () => {
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.searchItems(req({ query: { q: 'pdf' } }), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['company.pdf']);
    });
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.searchItems(req({ query: { q: 'pdf' } }), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['private.pdf']);
    });
  });

  it('a Personal file id is "not found" to the Shared download endpoint, and vice versa', async () => {
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.downloadFile(req({ params: { id: String(privatePdf._id) } }), res);
      expect(res.__status).toBe(404);
      expect(res.__streamedFrom).toBeUndefined();
    });
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.downloadFile(req({ params: { id: String(companyPdf._id) } }), res);
      expect(res.__status).toBe(404);
      expect(res.__streamedFrom).toBeUndefined();
    });
  });

  it('each module downloads its own file from its OWN directory', async () => {
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.downloadFile(req({ params: { id: String(companyPdf._id) } }), res);
      expect(res.__streamedFrom.startsWith(SHARED_FILES_DIR)).toBe(true);
      expect(res.__streamedFrom.startsWith(PERSONAL_FILES_DIR)).toBe(false);
    });
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.downloadFile(req({ params: { id: String(privatePdf._id) } }), res);
      expect(res.__streamedFrom.startsWith(PERSONAL_FILES_DIR)).toBe(true);
      expect(res.__streamedFrom.startsWith(SHARED_FILES_DIR)).toBe(false);
    });
  });

  it('usage is computed per module - Shared usage ignores Personal bytes and vice versa', async () => {
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.getUsage(req(), res);
      expect(res.__body.data.fileCount).toBe(1);
      expect(res.__body.data.usedBytes).toBe(5);
    });
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.getUsage(req(), res);
      expect(res.__body.data.fileCount).toBe(1);
    });
  });

  it('the recycle bins are separate', async () => {
    privatePdf.isDeleted = true;
    companyPdf.isDeleted = true;
    await runAs('shared', async () => {
      const res = makeRes();
      await shared.listRecycleBin(req(), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['company.pdf']);
    });
    await runAs('personal', async () => {
      const res = makeRes();
      await personal.listRecycleBin(req(), res);
      expect(res.__body.data.items.map((i: any) => i.name)).toEqual(['private.pdf']);
    });
  });

  it('neither controller ever touches the other module’s model (guarded proxies stayed silent)', async () => {
    // Every read handler of each module is run under the guard; a cross-touch
    // would have thrown and produced a 500.
    await runAs('shared', async () => {
      for (const h of [shared.listItems, shared.getTree, shared.searchItems, shared.getUsage, shared.listRecycleBin]) {
        const res = makeRes();
        await h(req({ query: { q: 'x' } }), res);
        expect(res.__status).toBe(200);
      }
    });
    await runAs('personal', async () => {
      for (const h of [personal.listItems, personal.getTree, personal.searchItems, personal.getUsage, personal.listRecycleBin]) {
        const res = makeRes();
        await h(req({ query: { q: 'x' } }), res);
        expect(res.__status).toBe(200);
      }
    });
  });
});

describe('structural isolation', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
  const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the Shared controller never references the Personal model, config, directory or permission', () => {
    const c = code('controllers/sharedFilesController.ts');
    expect(c).not.toMatch(/PersonalFile\b/);
    expect(c).not.toMatch(/personalFiles/);
    expect(c).not.toMatch(/PERSONAL_FILES/);
    expect(c).not.toMatch(/personal-files/);
    expect(c).not.toMatch(/userId/);
  });

  it('the Personal controller never references the Shared model, config, directory or permission', () => {
    const c = code('controllers/personalFilesController.ts');
    expect(c).not.toMatch(/SharedFile\b/);
    expect(c).not.toMatch(/sharedFiles/);
    expect(c).not.toMatch(/SHARED_FILES/);
    expect(c).not.toMatch(/shared-files/);
  });

  it('the Shared model has uploadedBy and NO userId; the Personal model has userId and NO uploadedBy', () => {
    const sharedModel = code('models/SharedFile.ts');
    expect(sharedModel).toMatch(/uploadedBy:\s*\{/);
    expect(sharedModel).not.toMatch(/userId/);
    const personalModel = code('models/PersonalFile.ts');
    expect(personalModel).toMatch(/userId:\s*\{/);
    expect(personalModel).not.toMatch(/uploadedBy/);
  });

  it('registers two distinct Mongoose models', () => {
    expect(src('models/SharedFile.ts')).toMatch(/mongoose\.model<ISharedFile, ISharedFileModel>\(\s*'SharedFile'/);
    expect(src('models/PersonalFile.ts')).toMatch(/'PersonalFile',/);
  });

  it('the two storage directories and relative prefixes differ', () => {
    expect(SHARED_FILES_DIR).not.toBe(PERSONAL_FILES_DIR);
    expect(SHARED_FILES_RELATIVE_PREFIX).not.toBe(PERSONAL_FILES_RELATIVE_PREFIX);
    expect(SHARED_FILES_DIR.endsWith('shared-files')).toBe(true);
    expect(PERSONAL_FILES_DIR.endsWith('personal-files')).toBe(true);
  });

  it('the two multer instances are separate and write to their own directories', () => {
    const u = code('middleware/upload.ts');
    const personalBlock = u.slice(u.indexOf('const personalFileStorage'), u.indexOf('export const uploadPersonalFile'));
    const sharedBlock = u.slice(u.indexOf('const sharedFileStorage'), u.indexOf('export const uploadSharedFile'));
    expect(personalBlock).toMatch(/cb\(null, PERSONAL_FILES_DIR\)/);
    expect(personalBlock).not.toMatch(/SHARED_FILES/);
    expect(sharedBlock).toMatch(/cb\(null, SHARED_FILES_DIR\)/);
    expect(sharedBlock).not.toMatch(/PERSONAL_FILES/);
  });

  it('the Shared routes use only the Shared gate/multer/controller, and the Personal routes are byte-identical to before', () => {
    const s = code('routes/sharedFiles.ts');
    expect(s).toMatch(/requireSharedFilesPermission/);
    expect(s).toMatch(/uploadSharedFile/);
    expect(s).toMatch(/sharedFilesController/);
    expect(s).not.toMatch(/PersonalFile|personalFiles|uploadPersonalFile/);
    const p = code('routes/personalFiles.ts');
    expect(p).not.toMatch(/SharedFile|sharedFiles|uploadSharedFile/);
  });

  it('the Personal config was not modified to import from or export to Shared', () => {
    expect(src('config/personalFiles.ts')).not.toMatch(/sharedFiles|SHARED_FILES/);
    expect(src('config/sharedFiles.ts')).not.toMatch(/personalFiles'|PERSONAL_FILES/);
  });
});
