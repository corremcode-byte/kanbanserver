import Redis from 'ioredis';
import crypto from 'crypto';

/**
 * Backs the browser-redirect flow for the Remote Server Workspace: the
 * browser is sent directly to the Guacamole subdomain (nginx-fronted,
 * outside this app), so the only leverage this backend has over who reaches
 * Guacamole is a short-lived, server-side-validated handoff.
 *
 * Two entry types, both validated by nginx via auth_request against this
 * app (see remoteServerController's redirect/entry and redirect/check
 * handlers):
 *
 *  - Nonce: single-use, ~30s TTL. Minted by GET /session/:serverId once a
 *    user's per-server permission has been checked; consumed exactly once
 *    when nginx's /guac-entry location validates it, in exchange for the
 *    real (shared-service-account) Guacamole token + client id.
 *  - Vetted cookie: multi-use (NOT deleted on check), ~10 min TTL. Issued
 *    at the same time as the nonce is consumed, so nginx can gate the
 *    Guacamole app-shell's document load ("/") for the lifetime of the
 *    cookie without another full authorization round-trip per asset.
 *
 * Mirrors the Redis-with-in-memory-fallback pattern used by dynamicRouteStore.
 */

const NONCE_TTL_SECONDS = 30;
const VETTED_TTL_SECONDS = 10 * 60;

export interface RedirectNonceEntry {
  userId: string;
  serverId: string;
  sessionLogId: string;
  guacToken: string;
  clientId: string;
}

export interface VettedCookieEntry {
  userId: string;
  serverId: string;
}

function generateId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

const memoryNonces = new Map<string, RedirectNonceEntry & { expiresAt: number }>();
const memoryVetted = new Map<string, VettedCookieEntry & { expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of memoryNonces) {
    if (entry.expiresAt < now) memoryNonces.delete(id);
  }
  for (const [id, entry] of memoryVetted) {
    if (entry.expiresAt < now) memoryVetted.delete(id);
  }
}, 60 * 1000);

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    _redis = new Redis(url, { maxRetriesPerRequest: 1 });
    _redis.on('error', () => { _redis = null; });
    return _redis;
  } catch {
    return null;
  }
}

const nonceKey = (id: string) => `remote_redirect_nonce:${id}`;
const vettedKey = (id: string) => `remote_redirect_vetted:${id}`;

async function createNonce(entry: RedirectNonceEntry): Promise<string> {
  const id = generateId();
  const redis = getRedis();

  if (redis) {
    await redis.setex(nonceKey(id), NONCE_TTL_SECONDS, JSON.stringify(entry));
  } else {
    memoryNonces.set(id, { ...entry, expiresAt: Date.now() + NONCE_TTL_SECONDS * 1000 });
  }

  return id;
}

/** Single-use: consuming a nonce immediately deletes it. */
async function consumeNonce(id: string): Promise<RedirectNonceEntry | null> {
  const redis = getRedis();

  if (redis) {
    const raw = await redis.get(nonceKey(id));
    if (!raw) return null;
    await redis.del(nonceKey(id));
    return JSON.parse(raw) as RedirectNonceEntry;
  }

  const entry = memoryNonces.get(id);
  if (!entry) return null;
  memoryNonces.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

async function createVettedCookie(entry: VettedCookieEntry): Promise<string> {
  const id = generateId();
  const redis = getRedis();

  if (redis) {
    await redis.setex(vettedKey(id), VETTED_TTL_SECONDS, JSON.stringify(entry));
  } else {
    memoryVetted.set(id, { ...entry, expiresAt: Date.now() + VETTED_TTL_SECONDS * 1000 });
  }

  return id;
}

/** Multi-use within its TTL — checking does NOT delete the entry. */
async function checkVettedCookie(id: string): Promise<VettedCookieEntry | null> {
  const redis = getRedis();

  if (redis) {
    const raw = await redis.get(vettedKey(id));
    return raw ? (JSON.parse(raw) as VettedCookieEntry) : null;
  }

  const entry = memoryVetted.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export const remoteRedirectStore = {
  createNonce,
  consumeNonce,
  createVettedCookie,
  checkVettedCookie
};
