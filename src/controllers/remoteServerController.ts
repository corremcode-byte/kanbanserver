import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { User, AuditLog } from '../models';
import { guacamoleApiService } from '../services/guacamoleApiService';
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
 * No token, nonce, or session of any kind is generated here — this just
 * checks the requesting user's module permission and hands back Guacamole's
 * own public URL. nginx proxies that subdomain straight through to
 * Guacamole; Guacamole's own login page and connection list handle
 * everything from there, entirely independent of Kanban.
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
    const redirectUrl = `${getGuacamolePublicUrl()}/`;

    try {
      await AuditLog.logSystemEvent({ userId, action: 'remote_workspace_accessed' });
    } catch (auditError) {
      logger.error('Failed to log remote_workspace_accessed event:', auditError);
    }

    successResponse(res, 'Redirect ready', { redirectUrl });
  } catch (error) {
    logger.error('Error resolving remote workspace redirect:', error);
    errorResponse(res, 'Remote workspace is currently unavailable. Please try again later.', 502);
  }
};
