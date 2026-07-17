import crypto from 'crypto';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { RemoteServer, User } from '../models';
import RemoteSessionLog from '../models/RemoteSessionLog';
import { guacamoleApiService } from '../services/guacamoleApiService';
import { remoteRedirectStore } from '../lib/remoteRedirectStore';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

// req.user (populated by the `authenticate` middleware) only carries role/identity
// fields, not the full permissions document — so access is checked against the
// database, same as every other module-permission check in this codebase
// (see middleware/permissions.ts).
async function hasModuleAccess(user: AuthenticatedRequest['user']): Promise<boolean> {
  if (!user?._id) return false;
  if (user.role === 'superadmin') return true;

  const dbUser = await User.findById(user._id).select('permissions.modules.remoteWorkspace');
  return dbUser?.permissions?.modules?.remoteWorkspace?.view === true;
}

function logConnectionsEnabled(): boolean {
  return process.env.LOG_CONNECTIONS !== 'false';
}

function clientIpOf(req: AuthenticatedRequest): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress;
}

function getGuacamolePublicUrl(): string {
  const url = process.env.GUACAMOLE_PUBLIC_URL || process.env.GUACAMOLE_URL;
  if (!url) throw new Error('GUACAMOLE_PUBLIC_URL/GUACAMOLE_URL is not configured');
  return url.replace(/\/+$/, '');
}

/**
 * Constant-time check that the caller is nginx, not a random internet
 * client — the two /redirect/* endpoints below can't require a Kanban JWT
 * (the browser's Kanban auth cookie isn't sent to the Guacamole subdomain),
 * so this shared secret is their only gate before the nonce/cookie checks.
 */
function isTrustedNginxCaller(req: Request): boolean {
  const expected = process.env.NGINX_INTERNAL_SECRET;
  const provided = req.headers['x-internal-secret'];
  if (!expected || typeof provided !== 'string' || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * GET /api/remote-workspace/servers — servers the current user may connect to.
 *
 * Authorization is the module-level `remoteWorkspace.view` permission alone —
 * anyone with it sees and can connect to every active server, regardless of
 * role. UserServerPermission (and its admin grant/revoke endpoints) still
 * exist and are still populated by the admin CRUD flow, but are no longer
 * consulted here; per-server restriction was judged more friction than value
 * for this deployment.
 */
export const listServers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await hasModuleAccess(req.user))) {
      errorResponse(res, 'You do not have access to the remote workspace', 403);
      return;
    }

    const servers = await RemoteServer.find({ isActive: true }).sort({ name: 1 });

    // Reflects Guacamole/guacd service reachability, not per-host reachability
    // (that would require an actual connect attempt per server).
    const online = await guacamoleApiService.isReachable();

    successResponse(res, 'Servers retrieved successfully', {
      servers: servers.map((s) => ({
        id: s._id.toString(),
        name: s.name,
        description: s.description || '',
        protocol: s.protocol,
        status: online ? 'online' : 'offline'
      }))
    });
  } catch (error) {
    logger.error('Error in listServers:', error);
    internalServerErrorResponse(res, 'Failed to retrieve servers');
  }
};

/**
 * GET /api/remote-workspace/session/:serverId
 * Authenticates with Guacamole using the backend service account and mints a
 * short-lived, single-use redirect nonce. The browser is handed a URL on the
 * Guacamole subdomain's gated entry point — never the real Guacamole token
 * or client id directly (those only ever travel server-to-server, between
 * this handler, the redirect nonce store, and nginx's auth_request call to
 * validateRedirectEntry below).
 *
 * Known limitation: once the browser leaves for the Guacamole subdomain,
 * this app has no way to detect disconnects — there's no embedded page to
 * hook into anymore. RemoteSessionLog records the request but "disconnected"
 * now depends on the user (or a future admin action) calling
 * DELETE /session explicitly, or on Guacamole's own idle timeout.
 */
export const createSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  const { serverId } = req.params;

  if (!(await hasModuleAccess(req.user))) {
    errorResponse(res, 'You do not have access to the remote workspace', 403);
    return;
  }

  // See listServers' doc comment — module-level view access is the only
  // gate; per-server UserServerPermission grants are no longer enforced.
  const server = await RemoteServer.findOne({ _id: serverId, isActive: true }).select('+guacamoleConnectionId +guacamoleDataSource');
  if (!server) {
    notFoundResponse(res, 'Server not found');
    return;
  }
  if (!server.guacamoleConnectionId || !server.guacamoleDataSource) {
    errorResponse(res, 'This server is not configured correctly. Please contact an administrator.', 502);
    return;
  }

  let sessionLogId: string | undefined;

  try {
    if (logConnectionsEnabled()) {
      const log = await RemoteSessionLog.create({
        serverId,
        userId,
        loginTime: new Date(),
        status: 'opened',
        clientIp: clientIpOf(req),
        browser: req.headers['user-agent']?.toString().slice(0, 300)
      });
      sessionLogId = log._id.toString();
    }

    const { authToken } = await guacamoleApiService.authenticate();
    const clientId = guacamoleApiService.buildClientId(server.guacamoleConnectionId, server.guacamoleDataSource);

    const nonce = await remoteRedirectStore.createNonce({
      userId,
      serverId: serverId,
      sessionLogId: sessionLogId || '',
      guacToken: authToken,
      clientId
    });

    const redirectUrl = `${getGuacamolePublicUrl()}/guac-entry?rid=${encodeURIComponent(nonce)}`;

    successResponse(res, 'Redirect ready', { redirectUrl });
  } catch (error) {
    logger.error('Error creating remote server session:', error);

    if (sessionLogId && logConnectionsEnabled()) {
      await RemoteSessionLog.findByIdAndUpdate(sessionLogId, {
        status: 'auth_failed',
        logoutTime: new Date()
      }).catch((): void => undefined);
    }

    errorResponse(res, 'Remote workspace is currently unavailable. Please try again later.', 502);
  }
};

/**
 * DELETE /api/remote-workspace/session
 * Best-effort, user-initiated disconnect signal — with the browser redirected
 * to Guacamole's own tab, there's no automatic hook for this anymore, so it
 * only fires if the user comes back to Kanban and explicitly ends the
 * session (e.g. a "Done" button), or a future scheduled job reaps stale
 * 'opened' logs past some max age.
 */
export const endSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  try {
    if (logConnectionsEnabled()) {
      const log = await RemoteSessionLog.findActiveForUser(userId);
      if (log) {
        log.status = 'disconnected';
        log.logoutTime = new Date();
        log.sessionDuration = Math.max(0, Math.round((log.logoutTime.getTime() - log.loginTime.getTime()) / 1000));
        await log.save();
      }
    }

    successResponse(res, 'Disconnected');
  } catch (error) {
    logger.error('Error ending remote server session:', error);
    internalServerErrorResponse(res, 'Failed to log disconnect');
  }
};

/**
 * GET /api/remote-workspace/redirect/entry — called by nginx's auth_request
 * for the Guacamole subdomain's /guac-entry location, never directly by a
 * browser. Consumes the single-use nonce minted by createSession and, on
 * success, hands nginx everything it needs (via response headers, which
 * auth_request_set can read) to 302 the browser straight into the real
 * Guacamole client view and to issue the short-lived "vetted" cookie that
 * gates the app-shell's document load (see checkRedirectVetted).
 */
export const validateRedirectEntry = async (req: Request, res: Response): Promise<void> => {
  if (!isTrustedNginxCaller(req)) {
    res.status(403).end();
    return;
  }

  const nonce = req.headers['x-redirect-nonce'];
  if (typeof nonce !== 'string' || !nonce) {
    res.status(403).end();
    return;
  }

  try {
    const entry = await remoteRedirectStore.consumeNonce(nonce);
    if (!entry) {
      res.status(403).end();
      return;
    }

    const vettedCookie = await remoteRedirectStore.createVettedCookie({
      userId: entry.userId,
      serverId: entry.serverId
    });

    res.set('X-Guac-Token', entry.guacToken);
    res.set('X-Guac-Client-Id', entry.clientId);
    res.set('X-Vetted-Cookie', vettedCookie);
    res.status(200).end();
  } catch (error) {
    logger.error('Error validating remote workspace redirect entry:', error);
    res.status(500).end();
  }
};

/**
 * GET /api/remote-workspace/redirect/check — called by nginx's auth_request
 * for the Guacamole subdomain's gated document-load location ("/"). Checks
 * the "vetted" cookie minted by validateRedirectEntry is still valid, so a
 * random visitor hitting the bare subdomain gets a 403 before ever seeing
 * Guacamole's own login page.
 */
export const checkRedirectVetted = async (req: Request, res: Response): Promise<void> => {
  if (!isTrustedNginxCaller(req)) {
    res.status(403).end();
    return;
  }

  const cookie = req.headers['x-vetted-cookie'];
  if (typeof cookie !== 'string' || !cookie) {
    res.status(403).end();
    return;
  }

  try {
    const entry = await remoteRedirectStore.checkVettedCookie(cookie);
    res.status(entry ? 200 : 403).end();
  } catch (error) {
    logger.error('Error checking remote workspace vetted cookie:', error);
    res.status(500).end();
  }
};
