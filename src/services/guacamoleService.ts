import { logger } from '../utils/logger';

/**
 * Talks to the already-running Apache Guacamole server's REST API using a
 * dedicated service account (GUACAMOLE_USERNAME/PASSWORD). This module is the
 * ONLY place in the codebase that ever sees a Guacamole auth token, the
 * Guacamole connection identifier, or the Guacamole/Windows RDP host — none
 * of it is allowed to reach the browser (see remoteWorkspaceController and
 * guacTunnelProxy, which relay bytes without exposing any of these values).
 */

interface GuacTokenResponse {
  authToken: string;
  username: string;
  dataSource: string;
  availableDataSources: string[];
}

interface CachedToken {
  authToken: string;
  dataSource: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

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
 * Obtain (and cache) a Guacamole auth token for the backend's service account.
 * Tokens are reused until ~1 minute before Guacamole's default 60-minute idle
 * timeout to avoid hammering the REST API on every connect click.
 */
async function authenticate(): Promise<{ authToken: string; dataSource: string }> {
  if (cached && cached.expiresAt > Date.now()) {
    return { authToken: cached.authToken, dataSource: cached.dataSource };
  }

  const username = process.env.GUACAMOLE_USERNAME;
  const password = process.env.GUACAMOLE_PASSWORD;
  if (!username || !password) {
    throw new Error('GUACAMOLE_USERNAME/GUACAMOLE_PASSWORD are not configured');
  }

  const body = new URLSearchParams({ username, password });
  const res = await fetchWithTimeout(`${getBaseUrl()}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    logger.error(`Guacamole authentication failed with status ${res.status}`);
    throw new Error('Guacamole authentication failed');
  }

  const data = (await res.json()) as GuacTokenResponse;
  // GUACAMOLE_DATASOURCE lets a multi-datasource Guacamole install (e.g. more
  // than one auth extension configured) pin which one owns GUACAMOLE_CONNECTION_ID.
  // Falls back to whatever Guacamole picked as the account's default.
  const dataSource = process.env.GUACAMOLE_DATASOURCE || data.dataSource;
  cached = {
    authToken: data.authToken,
    dataSource,
    expiresAt: Date.now() + 59 * 60 * 1000
  };

  return { authToken: data.authToken, dataSource };
}

/** Drop the cached token, e.g. after a 401 from Guacamole mid-session. */
function invalidateCache(): void {
  cached = null;
}

/**
 * Lightweight reachability probe used by GET /api/remote-workspace/status.
 * Does not require a real session — just confirms the Guacamole webapp answers.
 */
async function isReachable(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${getBaseUrl()}/api/languages`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/** The single shared RDP connection identifier configured in Guacamole. */
function getConnectionId(): string {
  const id = process.env.GUACAMOLE_CONNECTION_ID;
  if (!id) throw new Error('GUACAMOLE_CONNECTION_ID is not configured');
  return id;
}

/** ws:// or wss:// origin of the Guacamole server's tunnel endpoint. */
function getTunnelWsBase(): string {
  return getBaseUrl().replace(/^http/i, 'ws');
}

export const guacamoleService = {
  authenticate,
  invalidateCache,
  isReachable,
  getConnectionId,
  getTunnelWsBase
};
