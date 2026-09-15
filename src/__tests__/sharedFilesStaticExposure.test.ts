/**
 * Shared Files must never be reachable through the public /uploads static mount.
 *
 * Same SOURCE-assertion approach as personalFilesStaticExposure.test.ts, for the
 * same reason: the invariant is about middleware ORDER in server.ts (the bootstrap
 * that actually runs in production), and importing server.ts would open a
 * listener and a database connection.
 *
 * Shared files are private to authenticated users holding sharedFiles.view. If
 * `uploads/shared-files/` were served by the generic express.static mount, every
 * shared file would be world-readable to anyone who guessed a filename, and the
 * permission gate on GET /api/shared-files/:id/download would be meaningless.
 *
 * These also assert the Personal Files guard is STILL there and that the generic
 * mount for every other module was not touched.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_SRC = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const APP_SRC = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');

function guardIndex(source: string, prefix: string): number {
  return source.indexOf(`app.use('${prefix}'`);
}

function staticMountIndex(source: string): number {
  const match = /app\.use\(\s*'\/uploads'\s*,/.exec(source);
  return match ? match.index : -1;
}

describe('server.ts - the mount that actually runs in production', () => {
  it('registers a guard for /uploads/shared-files', () => {
    expect(guardIndex(SERVER_SRC, '/uploads/shared-files')).toBeGreaterThan(-1);
  });

  it('registers that guard BEFORE the generic /uploads static mount', () => {
    const guard = guardIndex(SERVER_SRC, '/uploads/shared-files');
    const staticMount = staticMountIndex(SERVER_SRC);
    expect(staticMount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(staticMount);
  });

  it('has the guard terminate the request rather than call next()', () => {
    const guard = guardIndex(SERVER_SRC, '/uploads/shared-files');
    const body = SERVER_SRC.slice(guard, SERVER_SRC.indexOf('});', guard));
    expect(body).toMatch(/res\.status\(404\)/);
    expect(body).not.toMatch(/next\(\)/);
  });

  it('keeps the Personal Files guard in place, also before the static mount', () => {
    const guard = guardIndex(SERVER_SRC, '/uploads/personal-files');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(staticMountIndex(SERVER_SRC));
  });

  it('still mounts the uploads directory for every other module, unchanged', () => {
    // Chat/task/support/avatar attachments keep their public serving, with the
    // same cache/inline headers as before.
    expect(SERVER_SRC).toMatch(/express\.static\(path\.join\(__dirname,\s*'\.\.\/uploads'\)\)/);
    const mount = SERVER_SRC.slice(staticMountIndex(SERVER_SRC), staticMountIndex(SERVER_SRC) + 500);
    expect(mount).toContain("'Cache-Control', 'public, max-age=31536000, immutable'");
    expect(mount).toContain("'Content-Disposition', 'inline'");
  });

  it('guards exactly the two private module prefixes and nothing broader', () => {
    // A guard on bare /uploads would break every public attachment.
    const guards = SERVER_SRC.match(/app\.use\('\/uploads\/[a-z-]+'/g) || [];
    expect(guards.sort()).toEqual(["app.use('/uploads/personal-files'", "app.use('/uploads/shared-files'"]);
  });
});

describe('app.ts - the secondary bootstrap', () => {
  it('also guards /uploads/shared-files before its static mount', () => {
    const guard = guardIndex(APP_SRC, '/uploads/shared-files');
    const staticMount = APP_SRC.indexOf("app.use('/uploads', express.static(");
    expect(guard).toBeGreaterThan(-1);
    expect(staticMount).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(staticMount);
  });

  it('keeps the Personal Files guard there too', () => {
    expect(guardIndex(APP_SRC, '/uploads/personal-files')).toBeGreaterThan(-1);
  });
});

describe('the storage directory is never handed to a client', () => {
  const CONTROLLER_SRC = readFileSync(
    join(__dirname, '..', 'controllers', 'sharedFilesController.ts'),
    'utf8'
  );

  it('omits storagePath from the API response shape', () => {
    const shape = CONTROLLER_SRC.slice(
      CONTROLLER_SRC.indexOf('function toApiItem'),
      CONTROLLER_SRC.indexOf('function decryptToApi')
    );
    expect(shape).toContain('mimeType');
    expect(shape).toContain('uploadedBy');
    expect(shape).not.toContain('storagePath');
  });

  it('exposes only { _id, displayName } of the uploader - no email, no role', () => {
    const shape = CONTROLLER_SRC.slice(
      CONTROLLER_SRC.indexOf('function toApiItem'),
      CONTROLLER_SRC.indexOf('function decryptToApi')
    );
    expect(shape).not.toMatch(/email/);
    expect(shape).not.toMatch(/role/);
    const lookup = CONTROLLER_SRC.slice(
      CONTROLLER_SRC.indexOf('async function attachUploaders'),
      CONTROLLER_SRC.indexOf('async function toApiList')
    );
    expect(lookup).toMatch(/\.select\('_id displayName'\)/);
  });

  it('never builds a public /uploads URL for a shared file', () => {
    const code = CONTROLLER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('/uploads/');
    expect(code).toContain('SHARED_FILES_RELATIVE_PREFIX');
  });

  it('uses the dedicated shared-files directory, never the personal-files one', () => {
    const CONFIG_SRC = readFileSync(join(__dirname, '..', 'config', 'sharedFiles.ts'), 'utf8');
    expect(CONFIG_SRC).toMatch(/'uploads',\s*'shared-files'/);
    expect(CONFIG_SRC).toMatch(/SHARED_FILES_RELATIVE_PREFIX = 'shared-files'/);
    expect(CONTROLLER_SRC).not.toMatch(/PERSONAL_FILES_DIR|personal-files/);
    const UPLOAD_SRC = readFileSync(join(__dirname, '..', 'middleware', 'upload.ts'), 'utf8');
    const sharedBlock = UPLOAD_SRC.slice(UPLOAD_SRC.indexOf('const sharedFileStorage'));
    expect(sharedBlock).toMatch(/cb\(null, SHARED_FILES_DIR\)/);
    expect(sharedBlock).not.toMatch(/PERSONAL_FILES_DIR/);
  });

  it('sends private, no-store, nosniff, sandboxed headers on download', () => {
    const download = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf('export const downloadFile'));
    expect(download).toContain("'Cache-Control', 'private, no-store'");
    expect(download).toContain("'X-Content-Type-Options', 'nosniff'");
    expect(download).toContain("'X-Frame-Options', 'DENY'");
    expect(download).toContain(`"default-src 'none'; sandbox"`);
  });
});
