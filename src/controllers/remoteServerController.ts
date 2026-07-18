import crypto from 'crypto';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { User, AuditLog } from '../models';
import { guacamoleApiService } from '../services/guacamoleApiService';
import { remoteRedirectStore } from '../lib/remoteRedirectStore';
import { successResponse, errorResponse } from '../utils/responses';
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

/** GET /api/remote-workspace/status — is the Guacamole webapp reachable at all */
export const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await hasModuleAccess(req.user))) {
      errorResponse(res, 'You do not have access to the remote workspace', 403);
      return;
    }

    const online = await guacamoleApiService.isReachable();
    successResponse(res, 'Status retrieved successfully', { status: online ? 'online' : 'offline' });
  } catch (error) {
    logger.error('Error in getStatus:', error);
    errorResponse(res, 'Failed to retrieve status', 500);
  }
};

/**
 * GET /api/remote-workspace/session
 * Mints a short-lived, single-use redirect nonce and hands the browser a URL
 * on the Guacamole subdomain's gated entry point. Kanban never touches
 * Guacamole credentials, connections, or tokens here — it only decides
 * whether this user is allowed to be sent there at all. Once through the
 * gate, Guacamole's own login page and connection list take over completely.
 */
export const createSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!(await hasModuleAccess(req.user))) {
    errorResponse(res, 'You do not have access to the remote workspace', 403);
    return;
  }

  try {
    const nonce = await remoteRedirectStore.createNonce({ userId });
    const redirectUrl = `${getGuacamolePublicUrl()}/guac-entry?rid=${encodeURIComponent(nonce)}`;

    try {
      await AuditLog.logSystemEvent({ userId, action: 'remote_workspace_accessed' });
    } catch (auditError) {
      logger.error('Failed to log remote_workspace_accessed event:', auditError);
    }

    successResponse(res, 'Redirect ready', { redirectUrl });
  } catch (error) {
    logger.error('Error creating remote workspace redirect:', error);
    errorResponse(res, 'Remote workspace is currently unavailable. Please try again later.', 502);
  }
};

/**
 * GET /api/remote-workspace/redirect/entry — called by nginx's auth_request
 * for the Guacamole subdomain's /guac-entry location, never directly by a
 * browser. Consumes the single-use nonce minted by createSession and, on
 * success, hands nginx the "vetted" cookie value (via a response header,
 * which auth_request_set can read) that gates the app-shell's document load
 * (see checkRedirectVetted). nginx then redirects the browser to Guacamole's
 * own bare login page.
 */
export const validateRedirectEntry = async (req: Request, res: Response): Promise<void> => {
  if (!isTrustedNginxCaller(req)) {
    logger.warn('Rejected redirect/entry: caller failed X-Internal-Secret check (missing/mismatched NGINX_INTERNAL_SECRET)');
    res.status(403).end();
    return;
  }

  const nonce = req.headers['x-redirect-nonce'];
  if (typeof nonce !== 'string' || !nonce) {
    logger.warn('Rejected redirect/entry: no X-Redirect-Nonce header on the request (check nginx sets it from $arg_rid)');
    res.status(403).end();
    return;
  }

  try {
    const entry = await remoteRedirectStore.consumeNonce(nonce);
    if (!entry) {
      logger.warn(`Rejected redirect/entry: nonce not found/expired/already used (nonce=${nonce.slice(0, 8)}...)`);
      res.status(403).end();
      return;
    }

    const vettedCookie = await remoteRedirectStore.createVettedCookie({ userId: entry.userId });

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
    logger.warn('Rejected redirect/check: caller failed X-Internal-Secret check (missing/mismatched NGINX_INTERNAL_SECRET)');
    res.status(403).end();
    return;
  }

  const cookie = req.headers['x-vetted-cookie'];
  if (typeof cookie !== 'string' || !cookie) {
    logger.warn('Rejected redirect/check: no X-Vetted-Cookie header on the request (check nginx sets it from $cookie_guac_vetted)');
    res.status(403).end();
    return;
  }

  try {
    const entry = await remoteRedirectStore.checkVettedCookie(cookie);
    if (!entry) {
      logger.warn(`Rejected redirect/check: vetted cookie not found/expired (cookie=${cookie.slice(0, 8)}...)`);
    }
    res.status(entry ? 200 : 403).end();
  } catch (error) {
    logger.error('Error checking remote workspace vetted cookie:', error);
    res.status(500).end();
  }
};
