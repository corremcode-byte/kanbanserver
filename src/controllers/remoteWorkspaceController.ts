import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ConnectionLog, User } from '../models';
import { guacamoleService } from '../services/guacamoleService';
import { remoteSessionStore } from '../lib/remoteSessionStore';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

const WORKSPACE_NAME = 'Company Windows Workspace';
const WORKSPACE_DESCRIPTION = 'Shared Windows Server';

// req.user (populated by the `authenticate` middleware) only carries role/identity
// fields, not the full permissions document — so access is checked against the
// database, same as every other module-permission check in this codebase
// (see middleware/permissions.ts).
async function hasWorkspaceAccess(user: AuthenticatedRequest['user']): Promise<boolean> {
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

/** GET /api/remote-workspace — workspace card details + live status */
export const getWorkspace = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await hasWorkspaceAccess(req.user))) {
      errorResponse(res, 'You do not have access to the remote workspace', 403);
      return;
    }

    const online = await guacamoleService.isReachable();

    successResponse(res, 'Workspace retrieved successfully', {
      workspace: {
        name: WORKSPACE_NAME,
        description: WORKSPACE_DESCRIPTION,
        status: online ? 'online' : 'offline'
      }
    });
  } catch (error) {
    logger.error('Error in getWorkspace:', error);
    internalServerErrorResponse(res, 'Failed to retrieve workspace');
  }
};

/** GET /api/remote-workspace/status — lightweight availability check (used for polling) */
export const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await hasWorkspaceAccess(req.user))) {
      errorResponse(res, 'You do not have access to the remote workspace', 403);
      return;
    }

    const online = await guacamoleService.isReachable();
    successResponse(res, 'Status retrieved successfully', { status: online ? 'online' : 'offline' });
  } catch (error) {
    logger.error('Error in getStatus:', error);
    internalServerErrorResponse(res, 'Failed to retrieve status');
  }
};

/**
 * POST /api/remote-workspace/connect
 * Authenticates with Guacamole using the backend service account and hands
 * the browser back only an opaque, single-use session id — never the
 * Guacamole token, connection id, data source, or host. The browser uses
 * that id to open the WebSocket tunnel proxy (see guacTunnelProxy.ts).
 */
export const connect = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!(await hasWorkspaceAccess(req.user))) {
    errorResponse(res, 'You do not have access to the remote workspace', 403);
    return;
  }

  let connectionLogId: string | undefined;

  try {
    if (logConnectionsEnabled()) {
      const log = await ConnectionLog.create({
        userId,
        loginTime: new Date(),
        status: 'opened',
        clientIp: clientIpOf(req),
        browser: req.headers['user-agent']?.toString().slice(0, 300)
      });
      connectionLogId = log._id.toString();
    }

    const { authToken, dataSource } = await guacamoleService.authenticate();
    const connectionId = guacamoleService.getConnectionId();

    const sessionId = await remoteSessionStore.create({
      userId,
      guacToken: authToken,
      dataSource,
      connectionId,
      connectionLogId: connectionLogId || ''
    });

    successResponse(res, 'Session created', {
      sessionId,
      tunnelPath: '/api/remote-workspace/tunnel'
    });
  } catch (error) {
    logger.error('Error in remote workspace connect:', error);

    if (connectionLogId && logConnectionsEnabled()) {
      await ConnectionLog.findByIdAndUpdate(connectionLogId, {
        status: 'auth_failed',
        logoutTime: new Date()
      }).catch((): void => undefined);
    }

    errorResponse(res, 'Remote workspace is currently unavailable. Please try again later.', 502);
  }
};

/**
 * POST /api/remote-workspace/disconnect
 * Client-initiated disconnect signal (e.g. user clicks "Disconnect" or
 * navigates away). The tunnel proxy also logs unexpected drops on its own,
 * so this only needs to cover the clean, explicit case.
 */
export const disconnect = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  try {
    if (logConnectionsEnabled()) {
      const log = await ConnectionLog.findActiveForUser(userId);
      if (log) {
        log.status = 'disconnected';
        log.logoutTime = new Date();
        log.sessionDuration = Math.max(0, Math.round((log.logoutTime.getTime() - log.loginTime.getTime()) / 1000));
        await log.save();
      }
    }

    successResponse(res, 'Disconnected');
  } catch (error) {
    logger.error('Error in remote workspace disconnect:', error);
    internalServerErrorResponse(res, 'Failed to log disconnect');
  }
};
