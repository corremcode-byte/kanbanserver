/**
 * Guacamole itself now owns authentication and connection management
 * entirely — Kanban's role is just to gate who can reach the Guacamole
 * subdomain at all (see remoteServerController's redirect flow) and show a
 * simple online/offline indicator. This module is deliberately thin.
 */

function getTimeoutMs(): number {
  const raw = Number(process.env.GUACAMOLE_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

function getBaseUrl(): string {
  const url = process.env.GUACAMOLE_URL;
  if (!url) throw new Error('GUACAMOLE_URL is not configured');
  return url.replace(/\/+$/, '');
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lightweight reachability probe used by GET /api/remote-workspace/status.
 * Unauthenticated — /api/languages doesn't require a Guacamole session.
 */
async function isReachable(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${getBaseUrl()}/api/languages`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export const guacamoleApiService = {
  isReachable
};
