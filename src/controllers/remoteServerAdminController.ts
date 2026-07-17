import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { RemoteServer, UserServerPermission, AuditLog, User } from '../models';
import { IRemoteServer, RemoteServerProtocol } from '../models/RemoteServer';
import { guacamoleApiService, DecryptedServerCredentials } from '../services/guacamoleApiService';
import { encrypt, decrypt } from '../utils/encryption';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface RemoteServerRequestBody {
  name?: string;
  description?: string;
  protocol?: RemoteServerProtocol;
  hostname?: string;
  port?: number;
  domain?: string;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  protocolParams?: Record<string, unknown>;
  isActive?: boolean;
}

function decryptCreds(server: IRemoteServer): DecryptedServerCredentials {
  return {
    username: server.usernameEncrypted ? decrypt(server.usernameEncrypted) : undefined,
    password: server.passwordEncrypted ? decrypt(server.passwordEncrypted) : undefined,
    privateKey: server.privateKeyEncrypted ? decrypt(server.privateKeyEncrypted) : undefined,
    passphrase: server.passphraseEncrypted ? decrypt(server.passphraseEncrypted) : undefined
  };
}

/** GET /api/remote-workspace/admin/servers */
export const listAllServers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const servers = await RemoteServer.find().sort({ name: 1 });
    successResponse(res, 'Servers retrieved successfully', servers);
  } catch (error) {
    logger.error('Error listing remote servers:', error);
    internalServerErrorResponse(res, 'Failed to retrieve servers');
  }
};

/** GET /api/remote-workspace/admin/servers/:serverId */
export const getServer = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const server = await RemoteServer.findById(req.params.serverId);
    if (!server) {
      notFoundResponse(res, 'Server not found');
      return;
    }
    successResponse(res, 'Server retrieved successfully', server);
  } catch (error) {
    logger.error('Error getting remote server:', error);
    internalServerErrorResponse(res, 'Failed to retrieve server');
  }
};

/**
 * POST /api/remote-workspace/admin/servers
 * Provisions the connection in Guacamole FIRST, then persists the RemoteServer
 * doc — a doc only ever exists if its Guacamole connection was actually
 * created, keeping Mongo and Guacamole in sync.
 */
export const createServer = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as RemoteServerRequestBody;

  try {
    const { authToken: _authToken, dataSource } = await guacamoleApiService.authenticate();

    const creds: DecryptedServerCredentials = {
      username: body.username,
      password: body.password,
      privateKey: body.privateKey,
      passphrase: body.passphrase
    };

    const parameters = guacamoleApiService.buildGuacamoleParameters(
      body.protocol as RemoteServerProtocol,
      { hostname: body.hostname!, port: body.port!, domain: body.domain, protocolParams: body.protocolParams },
      creds
    );

    const guacamoleConnectionId = await guacamoleApiService.createConnection(dataSource, {
      protocol: body.protocol as RemoteServerProtocol,
      name: body.name!,
      parameters
    });

    let server: IRemoteServer;
    try {
      server = await RemoteServer.create({
        name: body.name,
        description: body.description || '',
        protocol: body.protocol,
        hostname: body.hostname,
        port: body.port,
        domain: body.domain,
        usernameEncrypted: creds.username ? encrypt(creds.username) : undefined,
        passwordEncrypted: creds.password ? encrypt(creds.password) : undefined,
        privateKeyEncrypted: creds.privateKey ? encrypt(creds.privateKey) : undefined,
        passphraseEncrypted: creds.passphrase ? encrypt(creds.passphrase) : undefined,
        protocolParams: body.protocolParams || {},
        guacamoleConnectionId,
        guacamoleDataSource: dataSource,
        isActive: body.isActive ?? true,
        createdBy: req.user!._id
      });
    } catch (mongoError) {
      // Guacamole connection was created but the Mongo write failed — clean up
      // the orphaned upstream connection rather than leaving it dangling.
      await guacamoleApiService.deleteConnection(dataSource, guacamoleConnectionId).catch((): void => undefined);
      throw mongoError;
    }

    try {
      await AuditLog.logAction({
        userId: req.user!._id,
        action: 'remote_server_created',
        entityType: 'remote_server',
        entityId: server._id.toString(),
        metadata: { name: server.name, protocol: server.protocol, hostname: server.hostname, port: server.port }
      });
    } catch (auditError) {
      logger.error('Failed to log remote_server_created event:', auditError);
    }

    successResponse(res, 'Server created successfully', server, 201);
  } catch (error) {
    logger.error('Error creating remote server:', error);
    errorResponse(res, 'Failed to create remote server — check that Guacamole is reachable and configured correctly', 502);
  }
};

/**
 * PUT /api/remote-workspace/admin/servers/:serverId
 * Write-only credential semantics (same as User.password): omitted credential
 * fields keep their existing value. Guacamole's PUT replaces the entire
 * parameter set, so the full merged set is always sent upstream.
 */
export const updateServer = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as RemoteServerRequestBody;

  try {
    const server = await RemoteServer.findById(req.params.serverId)
      .select('+usernameEncrypted +passwordEncrypted +privateKeyEncrypted +passphraseEncrypted +guacamoleConnectionId +guacamoleDataSource');

    if (!server) {
      notFoundResponse(res, 'Server not found');
      return;
    }
    if (!server.guacamoleConnectionId || !server.guacamoleDataSource) {
      errorResponse(res, 'This server is not configured correctly and cannot be updated', 502);
      return;
    }

    const existingCreds = decryptCreds(server);
    const mergedCreds: DecryptedServerCredentials = {
      username: body.username !== undefined ? body.username : existingCreds.username,
      password: body.password !== undefined ? body.password : existingCreds.password,
      privateKey: body.privateKey !== undefined ? body.privateKey : existingCreds.privateKey,
      passphrase: body.passphrase !== undefined ? body.passphrase : existingCreds.passphrase
    };

    const mergedFields = {
      name: body.name ?? server.name,
      protocol: (body.protocol ?? server.protocol) as RemoteServerProtocol,
      hostname: body.hostname ?? server.hostname,
      port: body.port ?? server.port,
      domain: body.domain !== undefined ? body.domain : server.domain,
      protocolParams: body.protocolParams ?? server.protocolParams
    };

    const parameters = guacamoleApiService.buildGuacamoleParameters(
      mergedFields.protocol,
      { hostname: mergedFields.hostname, port: mergedFields.port, domain: mergedFields.domain, protocolParams: mergedFields.protocolParams },
      mergedCreds
    );

    await guacamoleApiService.updateConnection(server.guacamoleDataSource, server.guacamoleConnectionId, {
      protocol: mergedFields.protocol,
      name: mergedFields.name,
      parameters
    });

    server.name = mergedFields.name;
    server.description = body.description !== undefined ? body.description : server.description;
    server.protocol = mergedFields.protocol;
    server.hostname = mergedFields.hostname;
    server.port = mergedFields.port;
    server.domain = mergedFields.domain;
    server.protocolParams = mergedFields.protocolParams;
    if (mergedCreds.username !== undefined) server.usernameEncrypted = mergedCreds.username ? encrypt(mergedCreds.username) : undefined;
    if (mergedCreds.password !== undefined) server.passwordEncrypted = mergedCreds.password ? encrypt(mergedCreds.password) : undefined;
    if (mergedCreds.privateKey !== undefined) server.privateKeyEncrypted = mergedCreds.privateKey ? encrypt(mergedCreds.privateKey) : undefined;
    if (mergedCreds.passphrase !== undefined) server.passphraseEncrypted = mergedCreds.passphrase ? encrypt(mergedCreds.passphrase) : undefined;
    if (body.isActive !== undefined) server.isActive = body.isActive;
    server.updatedBy = req.user!._id as unknown as IRemoteServer['updatedBy'];

    await server.save();

    try {
      await AuditLog.logAction({
        userId: req.user!._id,
        action: 'remote_server_updated',
        entityType: 'remote_server',
        entityId: server._id.toString(),
        metadata: { name: server.name, protocol: server.protocol }
      });
    } catch (auditError) {
      logger.error('Failed to log remote_server_updated event:', auditError);
    }

    successResponse(res, 'Server updated successfully', server);
  } catch (error) {
    logger.error('Error updating remote server:', error);
    errorResponse(res, 'Failed to update remote server — check that Guacamole is reachable and configured correctly', 502);
  }
};

/** DELETE /api/remote-workspace/admin/servers/:serverId */
export const deleteServer = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const server = await RemoteServer.findById(req.params.serverId).select('+guacamoleConnectionId +guacamoleDataSource');
    if (!server) {
      notFoundResponse(res, 'Server not found');
      return;
    }

    if (server.guacamoleConnectionId && server.guacamoleDataSource) {
      await guacamoleApiService.deleteConnection(server.guacamoleDataSource, server.guacamoleConnectionId);
    }

    await UserServerPermission.deleteMany({ serverId: server._id });
    // RemoteSessionLog rows are intentionally kept — the audit trail survives server deletion.
    await RemoteServer.findByIdAndDelete(server._id);

    try {
      await AuditLog.logAction({
        userId: req.user!._id,
        action: 'remote_server_deleted',
        entityType: 'remote_server',
        entityId: server._id.toString(),
        metadata: { name: server.name }
      });
    } catch (auditError) {
      logger.error('Failed to log remote_server_deleted event:', auditError);
    }

    successResponse(res, 'Server deleted successfully');
  } catch (error) {
    logger.error('Error deleting remote server:', error);
    internalServerErrorResponse(res, 'Failed to delete remote server');
  }
};

/** GET /api/remote-workspace/admin/servers/:serverId/permissions */
export const listServerPermissions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const grants = await UserServerPermission.find({ serverId: req.params.serverId })
      .populate('userId', 'displayName email photoURL role')
      .sort({ createdAt: -1 });
    successResponse(res, 'Permissions retrieved successfully', grants);
  } catch (error) {
    logger.error('Error listing server permissions:', error);
    internalServerErrorResponse(res, 'Failed to retrieve permissions');
  }
};

/** POST /api/remote-workspace/admin/permissions */
export const grantPermission = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId, serverId, canConnect } = req.body as { userId: string; serverId: string; canConnect?: boolean };

  try {
    const [server, user] = await Promise.all([RemoteServer.findById(serverId), User.findById(userId)]);
    if (!server) {
      notFoundResponse(res, 'Server not found');
      return;
    }
    if (!user) {
      notFoundResponse(res, 'User not found');
      return;
    }

    const grant = await UserServerPermission.findOneAndUpdate(
      { serverId, userId },
      { canConnect: canConnect ?? true, grantedBy: req.user!._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate('userId', 'displayName email photoURL role');

    try {
      await AuditLog.logAction({
        userId: req.user!._id,
        action: 'remote_server_permission_granted',
        entityType: 'remote_server',
        entityId: serverId,
        metadata: { targetUserId: userId, serverName: server.name }
      });
    } catch (auditError) {
      logger.error('Failed to log remote_server_permission_granted event:', auditError);
    }

    successResponse(res, 'Permission granted successfully', grant);
  } catch (error) {
    logger.error('Error granting server permission:', error);
    internalServerErrorResponse(res, 'Failed to grant permission');
  }
};

/** DELETE /api/remote-workspace/admin/permissions/:serverId/:userId */
export const revokePermission = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { serverId, userId } = req.params;

  try {
    const deleted = await UserServerPermission.findOneAndDelete({ serverId, userId });
    if (!deleted) {
      notFoundResponse(res, 'Permission not found');
      return;
    }

    try {
      await AuditLog.logAction({
        userId: req.user!._id,
        action: 'remote_server_permission_revoked',
        entityType: 'remote_server',
        entityId: serverId,
        metadata: { targetUserId: userId }
      });
    } catch (auditError) {
      logger.error('Failed to log remote_server_permission_revoked event:', auditError);
    }

    successResponse(res, 'Permission revoked successfully');
  } catch (error) {
    logger.error('Error revoking server permission:', error);
    internalServerErrorResponse(res, 'Failed to revoke permission');
  }
};
