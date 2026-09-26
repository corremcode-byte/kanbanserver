import Redis from 'ioredis';
import crypto from 'crypto';

const ROUTE_TTL = 1800; // 30 minutes of inactivity

// 18 random bytes → exactly 24 base64url characters (no padding), using only
// [A-Za-z0-9_-] — URL-safe by construction, higher entropy per char than hex.
const ROUTE_TOKEN_BYTES = 18;
function generateToken(): string {
  return crypto.randomBytes(ROUTE_TOKEN_BYTES).toString('base64url');
}

interface RouteEntry {
  userId: string;
  destination: string;
  createdAt: number;
  isPublic?: boolean;
}

// Public pages that don't require authentication
const PUBLIC_DESTINATIONS = new Set(['/shiva', '/signup', '/forgot-password', '/passkey', '/passkey-setup']);

// ── In-memory fallback ─────────────────────────────────────────────────────────

const memoryRoutes = new Map<string, RouteEntry & { expiresAt: number }>();
// userId → destination → token  (so we can invalidate old token when same dest is re-navigated)
const userDestIndex = new Map<string, Map<string, string>>();
// userId → Set<token>  (for bulk logout invalidation)
const userTokenIndex = new Map<string, Set<string>>();

// Sweep expired entries every 5 minutes. unref() so this housekeeping timer
// never keeps the Node process (or a test run) alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of memoryRoutes) {
    if (entry.expiresAt < now) memoryRoutes.delete(token);
  }
}, 5 * 60 * 1000).unref?.();

// ── Redis singleton ─────────────────────────────────────────────────────────────

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

// ── Keys ────────────────────────────────────────────────────────────────────────

const routeKey  = (token: string)               => `dyn_route:${token}`;
const destKey   = (userId: string, dest: string) => `dyn_dest:${userId}:${Buffer.from(dest).toString('base64url')}`;
const tokenSet  = (userId: string)               => `dyn_tokens:${userId}`;

// ── Public API ──────────────────────────────────────────────────────────────────

// One live token per user + destination. If that token is still valid it is
// REUSED (TTL refreshed) rather than rotated: rotating deleted the old token,
// which broke any other open tab — or a hover-prefetch — still holding that
// page's /r/<token> URL, sending it back to the root page on refresh.
// Tokens remain per-user, still expire after ROUTE_TTL of inactivity, and are
// still all wiped by clearUserRoutes() on logout.
async function generateRoute(userId: string, destination: string): Promise<string> {
  const redis = getRedis();

  if (redis) {
    const existing = await redis.get(destKey(userId, destination));
    if (existing) {
      const raw = await redis.get(routeKey(existing));
      const entry = raw ? (JSON.parse(raw) as RouteEntry) : null;
      if (entry && entry.userId === userId && entry.destination === destination) {
        const pipe = redis.pipeline();
        pipe.expire(routeKey(existing), ROUTE_TTL);
        pipe.expire(destKey(userId, destination), ROUTE_TTL);
        pipe.sadd(tokenSet(userId), existing);
        pipe.expire(tokenSet(userId), ROUTE_TTL);
        await pipe.exec();
        return existing;
      }
    }

    // No live token for this destination — store a new one
    const token = generateToken();
    const entry: RouteEntry = { userId, destination, createdAt: Date.now() };
    const pipe = redis.pipeline();
    pipe.setex(routeKey(token), ROUTE_TTL, JSON.stringify(entry));
    pipe.setex(destKey(userId, destination), ROUTE_TTL, token);
    pipe.sadd(tokenSet(userId), token);
    pipe.expire(tokenSet(userId), ROUTE_TTL);
    await pipe.exec();
    return token;
  }

  // Memory fallback — same reuse-if-still-valid rule as the Redis path
  const now = Date.now();
  const userDest = userDestIndex.get(userId);
  const existing = userDest?.get(destination);
  if (existing) {
    const entry = memoryRoutes.get(existing);
    if (entry && entry.expiresAt >= now && entry.userId === userId && entry.destination === destination) {
      entry.expiresAt = now + ROUTE_TTL * 1000;
      return existing;
    }
    // Stale mapping (expired or swept) — drop it before issuing a new token
    memoryRoutes.delete(existing);
    userTokenIndex.get(userId)?.delete(existing);
    userDest!.delete(destination);
  }

  const token = generateToken();
  memoryRoutes.set(token, { userId, destination, createdAt: now, expiresAt: now + ROUTE_TTL * 1000 });
  if (!userDestIndex.has(userId))  userDestIndex.set(userId, new Map());
  if (!userTokenIndex.has(userId)) userTokenIndex.set(userId, new Set());
  userDestIndex.get(userId)!.set(destination, token);
  userTokenIndex.get(userId)!.add(token);
  return token;
}

async function validateRoute(token: string): Promise<RouteEntry | null> {
  const redis = getRedis();

  if (redis) {
    const raw = await redis.get(routeKey(token));
    if (!raw) return null;
    const entry = JSON.parse(raw) as RouteEntry;
    // Refresh TTL on every access (activity-based expiry)
    await redis.expire(routeKey(token), ROUTE_TTL);
    return entry;
  }

  // Memory fallback
  const entry = memoryRoutes.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { memoryRoutes.delete(token); return null; }
  entry.expiresAt = Date.now() + ROUTE_TTL * 1000; // refresh
  return entry;
}

async function clearUserRoutes(userId: string): Promise<void> {
  const redis = getRedis();

  if (redis) {
    const tokens = await redis.smembers(tokenSet(userId));
    if (tokens.length > 0) {
      const pipe = redis.pipeline();
      tokens.forEach(t => pipe.del(routeKey(t)));
      pipe.del(tokenSet(userId));
      await pipe.exec();
    }
    // Also clear dest-index keys — use scan to find them safely
    const stream = redis.scanStream({ match: `dyn_dest:${userId}:*`, count: 100 });
    const destKeys: string[] = [];
    await new Promise<void>((resolve) => {
      stream.on('data', (keys: string[]) => destKeys.push(...keys));
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    if (destKeys.length > 0) await redis.del(...destKeys);
  } else {
    const tokens = userTokenIndex.get(userId);
    if (tokens) tokens.forEach(t => memoryRoutes.delete(t));
    userTokenIndex.delete(userId);
    userDestIndex.delete(userId);
  }
}

// Generate a route token for public (unauthenticated) pages.
// No userId is attached; the token is short-lived (10 min).
async function generatePublicRoute(destination: string): Promise<string> {
  if (!PUBLIC_DESTINATIONS.has(destination)) {
    throw new Error(`Destination "${destination}" is not a permitted public route`);
  }

  const redis = getRedis();
  const token = generateToken();
  const PUBLIC_TTL = 600; // 10 minutes
  const entry: RouteEntry = { userId: '', destination, createdAt: Date.now(), isPublic: true };

  if (redis) {
    await redis.setex(routeKey(token), PUBLIC_TTL, JSON.stringify(entry));
  } else {
    memoryRoutes.set(token, { ...entry, expiresAt: Date.now() + PUBLIC_TTL * 1000 });
  }

  return token;
}

export const dynamicRouteStore = { generateRoute, generatePublicRoute, validateRoute, clearUserRoutes };
