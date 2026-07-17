import { logger } from '../utils/logger';
import { RemoteServerProtocol } from '../models/RemoteServer';

/**
 * Talks to the already-running Apache Guacamole server's REST API using a
 * dedicated service account (GUACAMOLE_USERNAME/PASSWORD). This module is the
 * only place in the codebase that ever sees the service account's Guacamole
 * auth token or a target machine's RDP/SSH/VNC credentials in plaintext.
 *
 * NOTE on the token: remoteServerController's redirect flow DOES eventually
 * hand this service-account token to the browser (embedded in the Guacamole
 * deep-link URL nginx redirects to) — that's an accepted trade-off of
 * exposing Guacamole directly on its own subdomain rather than proxying the
 * desktop stream through this backend. The token authenticates as the
 * shared service account, so it can reach any connection that account can
 * see, not just the one the user was granted — nonce/cookie gating (see
 * remoteRedirectStore) only controls *whether* a browser gets a token at
 * all, not what that token can subsequently be used for once issued.
 *
 * Target-machine credentials (RDP/SSH/VNC passwords, private keys) never
 * reach the browser — they're pushed into the Guacamole connection object
 * itself (via createConnection/updateConnection) so guacd always has what
 * it needs and never needs to live-prompt for them.
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

export interface GuacamoleConnectionParams {
  protocol: RemoteServerProtocol;
  name: string;
  parameters: Record<string, string>;
  attributes?: Record<string, string>;
}

export interface DecryptedServerCredentials {
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface RemoteServerLike {
  hostname: string;
  port: number;
  domain?: string;
  protocolParams?: Record<string, unknown>;
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
  // than one auth extension configured) pin which one owns our connections.
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
 * Lightweight reachability probe used by GET /api/remote-workspace/servers.
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

/**
 * Builds the opaque "client ID" Guacamole's own webapp uses in its
 * #/client/<id> deep-link URLs — a base64url encoding (no padding) of
 * "<identifier>\0c\0<dataSource>" (type 'c' = connection). Guacamole's
 * client-side ClientIdentifier.fromString() decodes it as id/type/dataSource
 * in that order.
 *
 * NOTE: this field order is reconstructed from Guacamole's client-side
 * source, not verified against a live instance in this codebase — sanity
 * check the resulting deep link against your actual Guacamole version once
 * (e.g. open a connection through Guacamole's own UI and compare the
 * generated #/client/... URL's decoded id/type/dataSource order).
 */
function buildClientId(connectionId: string, dataSource: string): string {
  const raw = `${connectionId}\0c\0${dataSource}`;
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Every authenticated Guacamole REST call (anything past /api/tokens) passes
 * the token as a `?token=` query parameter, not a header — this matches how
 * Guacamole's own AngularJS web client authenticates its REST calls.
 * Retries exactly once, with a fresh token, on 401/403.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = async (): Promise<Response> => {
    const { authToken } = await authenticate();
    const url = `${getBaseUrl()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`;
    return fetchWithTimeout(url, init);
  };

  let res = await doFetch();
  if (res.status === 401 || res.status === 403) {
    invalidateCache();
    res = await doFetch();
  }
  return res;
}

interface GuacamoleConnectionTreeEntry {
  identifier: string;
  name: string;
  parentIdentifier: string;
  protocol: string;
}

/**
 * Create a Guacamole connection with credentials baked into its parameters,
 * so guacd never needs to live-prompt the browser for them. Returns the new
 * connection's identifier.
 *
 * The REST API's documented response shape for POST .../connections is
 * ambiguous ("@TODO" in the unofficial API docs) — if the response body
 * doesn't include `identifier` directly, fall back to listing connections and
 * matching by name under ROOT. This fallback path should be confirmed once
 * against the real Guacamole deployment (see plan's verification notes).
 */
async function createConnection(dataSource: string, params: GuacamoleConnectionParams): Promise<string> {
  const res = await authedFetch(`/api/session/data/${encodeURIComponent(dataSource)}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentIdentifier: 'ROOT',
      name: params.name,
      protocol: params.protocol,
      parameters: params.parameters,
      attributes: params.attributes || {}
    })
  });

  if (!res.ok) {
    logger.error(`Guacamole createConnection failed with status ${res.status}`);
    throw new Error('Failed to create Guacamole connection');
  }

  let identifier: string | undefined;
  try {
    const body = (await res.json()) as { identifier?: string };
    identifier = body?.identifier;
  } catch {
    // Empty/non-JSON body — fall through to the GET-and-match fallback below.
  }

  if (identifier) return identifier;

  const listRes = await authedFetch(`/api/session/data/${encodeURIComponent(dataSource)}/connections`, {
    method: 'GET'
  });
  if (!listRes.ok) {
    throw new Error('Created Guacamole connection but could not resolve its identifier');
  }
  const tree = (await listRes.json()) as Record<string, GuacamoleConnectionTreeEntry>;
  const match = Object.values(tree).find(
    (entry) => entry.parentIdentifier === 'ROOT' && entry.name === params.name
  );
  if (!match) {
    throw new Error('Created Guacamole connection but could not resolve its identifier');
  }
  return match.identifier;
}

async function updateConnection(dataSource: string, connectionId: string, params: GuacamoleConnectionParams): Promise<void> {
  const res = await authedFetch(
    `/api/session/data/${encodeURIComponent(dataSource)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentIdentifier: 'ROOT',
        name: params.name,
        protocol: params.protocol,
        parameters: params.parameters,
        attributes: params.attributes || {}
      })
    }
  );

  if (!res.ok) {
    logger.error(`Guacamole updateConnection failed with status ${res.status}`);
    throw new Error('Failed to update Guacamole connection');
  }
}

/** Idempotent: a 404 (already gone) is treated as success. */
async function deleteConnection(dataSource: string, connectionId: string): Promise<void> {
  const res = await authedFetch(
    `/api/session/data/${encodeURIComponent(dataSource)}/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' }
  );

  if (!res.ok && res.status !== 404) {
    logger.error(`Guacamole deleteConnection failed with status ${res.status}`);
    throw new Error('Failed to delete Guacamole connection');
  }
}

function stringifyProtocolParams(protocolParams?: Record<string, unknown>): Record<string, string> {
  if (!protocolParams) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(protocolParams)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Maps a RemoteServer + its decrypted credentials to the protocol-specific
 * parameter set Guacamole expects. Keeps protocol knowledge in one place
 * instead of scattering it across admin controllers.
 */
function buildGuacamoleParameters(
  protocol: RemoteServerProtocol,
  server: RemoteServerLike,
  creds: DecryptedServerCredentials
): Record<string, string> {
  const extras = stringifyProtocolParams(server.protocolParams);
  const base = {
    hostname: server.hostname,
    port: String(server.port)
  };

  switch (protocol) {
    case 'rdp':
      return {
        ...base,
        username: creds.username || '',
        password: creds.password || '',
        domain: server.domain || '',
        security: extras.security ?? 'nla',
        'ignore-cert': extras['ignore-cert'] ?? 'true',
        ...extras
      };
    case 'ssh':
      return {
        ...base,
        username: creds.username || '',
        password: creds.password || '',
        'private-key': creds.privateKey || '',
        passphrase: creds.passphrase || '',
        ...extras
      };
    case 'vnc':
      return {
        ...base,
        password: creds.password || '',
        ...extras
      };
    case 'telnet':
      return {
        ...base,
        username: creds.username || '',
        password: creds.password || '',
        ...extras
      };
    default:
      return { ...base, ...extras };
  }
}

export const guacamoleApiService = {
  authenticate,
  invalidateCache,
  isReachable,
  createConnection,
  updateConnection,
  deleteConnection,
  buildGuacamoleParameters,
  buildClientId
};
