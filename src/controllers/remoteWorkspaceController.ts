import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { AuditLog } from '../models';
import { remoteWorkspaceService, InvalidConnectionInputError } from '../services/remoteWorkspaceService';
import { errorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

/**
 * POST /api/remote-workspace/connect
 * Validates the caller's permission + submitted host/port/username, then
 * streams back a dynamically generated .rdp file. Nothing is persisted —
 * the file only ever exists in memory for this request.
 */
export const connect = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?._id;
  if (!userId) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (!(await remoteWorkspaceService.hasModuleAccess(req.user))) {
    errorResponse(res, 'You do not have access to the remote workspace', 403);
    return;
  }

  try {
    const { ip, port, username } = req.body ?? {};
    const file = remoteWorkspaceService.buildConnectionFile({ kind: 'manual', ip, port, username });

    try {
      await AuditLog.logSystemEvent({ userId, action: 'remote_workspace_accessed' });
    } catch (auditError) {
      logger.error('Failed to log remote_workspace_accessed event:', auditError);
    }

    res.setHeader('Content-Type', 'application/x-rdp');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (error) {
    if (error instanceof InvalidConnectionInputError) {
      errorResponse(res, error.errors.join(', '), 422);
      return;
    }
    logger.error('Error generating remote workspace connection file:', error);
    errorResponse(res, 'Failed to generate the connection file. Please try again later.', 500);
  }
};
