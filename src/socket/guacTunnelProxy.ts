import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { ConnectionLog } from '../models';
import { remoteSessionStore } from '../lib/remoteSessionStore';
import { guacamoleService } from '../services/guacamoleService';
import { logger } from '../utils/logger';

/**
 * Proxies the Guacamole websocket-tunnel protocol between the browser and
 * the real Guacamole server, so the browser only ever talks to our own
 * backend. The upstream Guacamole auth token, connection id, data source and
 * host are read server-side from the one-time session created by
 * POST /api/remote-workspace/connect — none of it crosses the wire to the
 * client. This is a byte-for-byte relay; we never parse the Guacamole
 * protocol itself, only observe open/close for audit logging.
 */

const TUNNEL_PATH = '/api/remote-workspace/tunnel';

function logConnectionsEnabled(): boolean {
  return process.env.LOG_CONNECTIONS !== 'false';
}

// The real Guacamole webapp's tunnel endpoint only recognizes these
// GUAC_-prefixed parameter names (see TunnelRequest.java) — the bare names
// used on our own browser<->proxy query string mean nothing upstream.
// Forwarding them unprefixed silently no-ops: width/height/dpi fall back to
// Guacamole's built-in 1024x768@96dpi default, and — more importantly — the
// client's image mimetypes stay empty, leaving guacd with no encoding it's
// allowed to render the desktop with. That's what was producing "connects
// fine, guacd sends sync/ping forever, then disposes every layer and
// disconnects, having never sent a single img instruction" — the black
// screen this fixes.
const GUAC_PARAM_NAME: Record<string, string> = {
  width: 'GUAC_WIDTH',
  height: 'GUAC_HEIGHT',
  dpi: 'GUAC_DPI',
  audio: 'GUAC_AUDIO',
  video: 'GUAC_VIDEO',
  image: 'GUAC_IMAGE',
  timezone: 'GUAC_TIMEZONE'
};

// guacamole-common-js decodes PNG/JPEG natively (hardcoded "png"/"jpeg"
// instruction handlers) regardless of what's declared — the browser side
// never sends GUAC_IMAGE itself, so guarantee guacd always has a usable
// image encoding to pick from.
const DEFAULT_IMAGE_MIMETYPES = ['image/png', 'image/jpeg'];

function toUpstreamDisplayParams(displayParams: URLSearchParams): URLSearchParams {
  const upstreamParams = new URLSearchParams();
  for (const [key, value] of displayParams) {
    const guacKey = GUAC_PARAM_NAME[key];
    if (guacKey) upstreamParams.append(guacKey, value);
  }
  if (!upstreamParams.has('GUAC_IMAGE')) {
    for (const mimetype of DEFAULT_IMAGE_MIMETYPES) upstreamParams.append('GUAC_IMAGE', mimetype);
  }
  return upstreamParams;
}

async function finalizeLog(
  connectionLogId: string,
  status: 'auth_success' | 'auth_failed' | 'timeout' | 'disconnected' | 'unexpected_disconnect',
  disconnectReason?: string
): Promise<void> {
  if (!logConnectionsEnabled()) return;
  try {
    const log = await ConnectionLog.findById(connectionLogId);
    if (!log) return;

    // auth_success is an interim milestone, not a terminal state — don't stamp logoutTime for it.
    if (status === 'auth_success') {
      log.status = status;
      await log.save();
      return;
    }

    log.status = status;
    log.logoutTime = new Date();
    log.sessionDuration = Math.max(0, Math.round((log.logoutTime.getTime() - log.loginTime.getTime()) / 1000));
    if (disconnectReason) log.disconnectReason = disconnectReason.slice(0, 300);
    await log.save();
  } catch (error) {
    logger.error('Failed to update connection_logs entry:', error);
  }
}

export function attachGuacTunnelProxy(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  // Display/session parameters the browser is allowed to request — anything
  // else on the incoming query string (in particular attempts to smuggle a
  // different token/connection id) is ignored; those always come from the
  // server-side session entry, never from the client.
  const PASSTHROUGH_PARAMS = ['width', 'height', 'dpi', 'audio', 'video', 'image', 'timezone'];

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const { pathname, searchParams } = new URL(req.url || '', 'http://internal');
    if (pathname !== TUNNEL_PATH) return; // not ours — let other listeners (e.g. Socket.IO) handle it

    const sessionId = searchParams.get('sessionId');
    if (!sessionId) {
      socket.destroy();
      return;
    }

    const displayParams = new URLSearchParams();
    for (const key of PASSTHROUGH_PARAMS) {
      const value = searchParams.get(key);
      if (value) displayParams.set(key, value);
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      handleConnection(clientWs, sessionId, displayParams).catch((error) => {
        logger.error('Guacamole tunnel proxy error:', error);
        try { clientWs.close(1011, 'Internal error'); } catch { /* already closed */ }
      });
    });
  });

  logger.info(`Guacamole tunnel proxy listening on upgrade path ${TUNNEL_PATH}`);
}

async function handleConnection(clientWs: WebSocket, sessionId: string, displayParams: URLSearchParams): Promise<void> {
  const entry = await remoteSessionStore.consume(sessionId);
  if (!entry) {
    clientWs.close(4001, 'Session expired or already used');
    return;
  }

  // Sensible defaults if the browser didn't supply a size — matches what the
  // stock Guacamole web client sends, so guacd doesn't fall back to a
  // degenerate/zero-size display.
  if (!displayParams.has('width')) displayParams.set('width', '1024');
  if (!displayParams.has('height')) displayParams.set('height', '768');
  if (!displayParams.has('dpi')) displayParams.set('dpi', '96');

  const upstreamUrl =
    `${guacamoleService.getTunnelWsBase()}/websocket-tunnel` +
    `?token=${encodeURIComponent(entry.guacToken)}` +
    `&GUAC_DATA_SOURCE=${encodeURIComponent(entry.dataSource)}` +
    `&GUAC_ID=${encodeURIComponent(entry.connectionId)}` +
    `&GUAC_TYPE=c` +
    `&${toUpstreamDisplayParams(displayParams).toString()}`;

  const upstream = new WebSocket(upstreamUrl);
  const pending: Array<[data: Buffer, isBinary: boolean]> = [];
  let upstreamOpen = false;
  let cleanClientClose = false;

  const openTimer = setTimeout(() => {
    if (!upstreamOpen) {
      upstream.terminate();
      clientWs.close(1013, 'Connection timed out');
      void finalizeLog(entry.connectionLogId, 'timeout', 'guacd did not respond in time');
    }
  }, Number(process.env.GUACAMOLE_TIMEOUT) || 8000);

  upstream.on('open', () => {
    upstreamOpen = true;
    clearTimeout(openTimer);
    for (const [msg, isBinary] of pending.splice(0)) upstream.send(msg, { binary: isBinary });
    void finalizeLog(entry.connectionLogId, 'auth_success');
  });

  // The Guacamole protocol is text-based — ws's default Buffer relay would send
  // every frame as binary regardless of the original type, and the browser-side
  // Guacamole.WebSocketTunnel throws on receiving a Blob where it expects a string.
  // Preserving isBinary in both directions keeps text frames as text frames.
  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });

  upstream.on('close', (code) => {
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close();
    }
    if (!upstreamOpen) {
      void finalizeLog(entry.connectionLogId, 'auth_failed', `guacd closed before handshake (code ${code})`);
    } else {
      void finalizeLog(entry.connectionLogId, cleanClientClose ? 'disconnected' : 'unexpected_disconnect');
    }
  });

  upstream.on('error', (error) => {
    logger.warn('Guacamole upstream tunnel error:', error.message);
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push([data as Buffer, isBinary]);
  });

  clientWs.on('close', (code) => {
    cleanClientClose = code === 1000;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  clientWs.on('error', (error) => {
    logger.warn('Guacamole client tunnel error:', error.message);
  });
}
