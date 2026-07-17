import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validate, validateObjectId, remoteServerSchemas, remoteServerPermissionSchemas } from '../middleware/validation';
import { remoteSessionLimiter, remoteRedirectValidationLimiter } from '../middleware/rateLimiter';
import * as remoteServerController from '../controllers/remoteServerController';
import * as remoteServerAdminController from '../controllers/remoteServerAdminController';

const router = Router();

// ── nginx-only redirect validation (public, no Kanban JWT) ──────────────────
// Called exclusively by nginx's auth_request directive on the Guacamole
// subdomain — the browser never hits these directly, and the browser's
// Kanban auth cookie isn't sent cross-subdomain anyway. Gated by a shared
// secret header (checked inside the controller) instead of `authenticate`.
router.get('/redirect/entry', remoteRedirectValidationLimiter, remoteServerController.validateRedirectEntry);
router.get('/redirect/check', remoteRedirectValidationLimiter, remoteServerController.checkRedirectVetted);

// ── Everything below requires Kanban authentication ──────────────────────────
// Access to the module itself is further restricted inside the controllers
// via the remoteWorkspace module permission and, for individual servers,
// UserServerPermission grants.
router.use(authenticate);

// ── End-user flow ────────────────────────────────────────────────────────────
router.get('/servers', remoteServerController.listServers);
router.get('/session/:serverId', validateObjectId('serverId'), remoteSessionLimiter, remoteServerController.createSession);
router.delete('/session', remoteServerController.endSession);

// ── Admin flow — RemoteServer CRUD ───────────────────────────────────────────
router.get('/admin/servers', requireAdmin, remoteServerAdminController.listAllServers);
router.post('/admin/servers', requireAdmin, validate(remoteServerSchemas.create), remoteServerAdminController.createServer);
router.get('/admin/servers/:serverId', requireAdmin, validateObjectId('serverId'), remoteServerAdminController.getServer);
router.put('/admin/servers/:serverId', requireAdmin, validateObjectId('serverId'), validate(remoteServerSchemas.update), remoteServerAdminController.updateServer);
router.delete('/admin/servers/:serverId', requireAdmin, validateObjectId('serverId'), remoteServerAdminController.deleteServer);
router.get('/admin/servers/:serverId/permissions', requireAdmin, validateObjectId('serverId'), remoteServerAdminController.listServerPermissions);

// ── Admin flow — grant/revoke per-user server access ────────────────────────
router.post('/admin/permissions', requireAdmin, validate(remoteServerPermissionSchemas.grant), remoteServerAdminController.grantPermission);
router.delete('/admin/permissions/:serverId/:userId', requireAdmin, remoteServerAdminController.revokePermission);

export default router;
