/**
 * Personal Files must never be reachable through the public /uploads static mount.
 *
 * This is a SOURCE-assertion guard, deliberately, because the invariant it protects
 * is about middleware ORDER in the server bootstrap rather than about any one
 * function's return value. Importing server.ts would start a listener and open a
 * database connection, so the ordering is asserted against the file instead.
 *
 * Why this test exists: physical personal files live in `uploads/personal-files/`,
 * and `server.ts` mounts `express.static` on the whole `uploads` directory. Without
 * a guard registered BEFORE that mount, every personal file is world-readable to
 * any unauthenticated caller who knows or guesses its filename, which would defeat
 * the per-user ownership checks on every /api/personal-files route. This was
 * verified to be the real behaviour before the guard was added.
 *
 * If this test fails, personal files are probably publicly downloadable. Do not
 * "fix" it by deleting the assertion.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_SRC = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const APP_SRC = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');

/** Index of the guard that refuses /uploads/personal-files. */
function guardIndex(source: string): number {
  return source.indexOf("app.use('/uploads/personal-files'");
}

/** Index of the generic static mount for the whole uploads directory. */
function staticMountIndex(source: string): number {
  const match = /app\.use\(\s*'\/uploads'\s*,/.exec(source);
  return match ? match.index : -1;
}

describe('server.ts - the mount that actually runs in production', () => {
  it('registers a guard for /uploads/personal-files', () => {
    expect(guardIndex(SERVER_SRC)).toBeGreaterThan(-1);
  });

  it('registers that guard BEFORE the generic /uploads static mount', () => {
    // Express matches middleware in registration order: a guard registered after
    // express.static would never be reached.
    const guard = guardIndex(SERVER_SRC);
    const staticMount = staticMountIndex(SERVER_SRC);
    expect(staticMount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(staticMount);
  });

  it('has the guard terminate the request rather than call next()', () => {
    const guard = guardIndex(SERVER_SRC);
    const body = SERVER_SRC.slice(guard, SERVER_SRC.indexOf('});', guard));
    expect(body).toMatch(/res\.status\(404\)/);
    // Calling next() would hand the request straight to express.static.
    expect(body).not.toMatch(/next\(\)/);
  });

  it('still mounts the uploads directory for every other module', () => {
    // The fix must not have removed public serving of chat/task/support/avatar
    // attachments, which the rest of the app depends on.
    expect(SERVER_SRC).toMatch(/express\.static\(path\.join\(__dirname,\s*'\.\.\/uploads'\)\)/);
  });
});

describe('app.ts - the secondary bootstrap', () => {
  // app.ts is not what server.ts boots, but it builds an equivalent express app
  // with its own /uploads static handler. The same guard is present there so the
  // exposure cannot reappear if anything ever serves through it.
  it('also guards /uploads/personal-files before its static mount', () => {
    const guard = guardIndex(APP_SRC);
    const staticMount = APP_SRC.indexOf("app.use('/uploads', express.static(");
    expect(guard).toBeGreaterThan(-1);
    expect(staticMount).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(staticMount);
  });
});

describe('the storage directory is never handed to a client', () => {
  const CONTROLLER_SRC = readFileSync(
    join(__dirname, '..', 'controllers', 'personalFilesController.ts'),
    'utf8'
  );

  it('omits storagePath from the API response shape', () => {
    const shape = CONTROLLER_SRC.slice(
      CONTROLLER_SRC.indexOf('function toApiItem'),
      CONTROLLER_SRC.indexOf('function decryptToApi')
    );
    expect(shape).toContain('mimeType');
    // The physical location is server-only; leaking it would hand out a path that
    // a future misconfiguration could make fetchable.
    expect(shape).not.toContain('storagePath');
  });

  it('never builds a public /uploads URL for a personal file', () => {
    // Comments are stripped first: the controller's own documentation explains the
    // /uploads exposure it avoids, and that prose must not satisfy or defeat an
    // assertion about actual code.
    const code = CONTROLLER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('/uploads/');
    // The only path the controller composes is the relative storage prefix, which
    // is resolved against PERSONAL_FILES_DIR server-side, never served as a URL.
    expect(code).toContain('PERSONAL_FILES_RELATIVE_PREFIX');
  });
});
