import Redis from 'ioredis';
import crypto from 'crypto';

/**
 * Short-lived, single-use handoff between POST /remote-workspace/connect
 * (which talks to Guacamole and knows the real token/connection id) and the
 * WebSocket tunnel proxy (which needs those values to open the upstream
 * connection to guacd). The browser only ever sees the opaque session id
 * returned here — never the Guacamole auth token, connection id, or host.
 *
 * Mirrors the Redis-with-in-memory-fallback pattern used by dynamicRouteStore.
 */

const SESSION_TTL_SECONDS = 60; // must be claimed by the WS proxy within a minute

export interface RemoteSessionEntry {
  userId: string;
  guacToken: string;
  dataSource: string;
  connectionId: string;
  connectionLogId: string;
}

function generateSessionId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

const memorySessions = new Map<string, RemoteSessionEntry & { expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of memorySessions) {
    if (entry.expiresAt < now) memorySessions.delete(id);
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

const sessionKey = (id: string) => `remote_ws_session:${id}`;

async function create(entry: RemoteSessionEntry): Promise<string> {
  const id = generateSessionId();
  const redis = getRedis();

  if (redis) {
    await redis.setex(sessionKey(id), SESSION_TTL_SECONDS, JSON.stringify(entry));
  } else {
    memorySessions.set(id, { ...entry, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  }

  return id;
}

/** Single-use: consuming a session id immediately deletes it. */
async function consume(id: string): Promise<RemoteSessionEntry | null> {
  const redis = getRedis();

  if (redis) {
    const raw = await redis.get(sessionKey(id));
    if (!raw) return null;
    await redis.del(sessionKey(id));
    return JSON.parse(raw) as RemoteSessionEntry;
  }

  const entry = memorySessions.get(id);
  if (!entry) return null;
  memorySessions.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export const remoteSessionStore = { create, consume };
