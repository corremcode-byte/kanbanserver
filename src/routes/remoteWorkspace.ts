import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { remoteSessionLimiter, remoteRedirectValidationLimiter } from '../middleware/rateLimiter';
import * as remoteServerController from '../controllers/remoteServerController';

const router = Router();

// ── nginx-only redirect validation (public, no Kanban JWT) ──────────────────
// Called exclusively by nginx's auth_request directive on the Guacamole
// subdomain — the browser never hits these directly, and the browser's
// Kanban auth cookie isn't sent cross-subdomain anyway. Gated by a shared
// secret header (checked inside the controller) instead of `authenticate`.
router.get('/redirect/entry', remoteRedirectValidationLimiter, remoteServerController.validateRedirectEntry);
router.get('/redirect/check', remoteRedirectValidationLimiter, remoteServerController.checkRedirectVetted);

// ── Everything below requires Kanban authentication ──────────────────────────
// Access to the module itself is gated by the remoteWorkspace module
// permission, checked inside the controller. Once past the redirect gate,
// Guacamole's own login page and permission model take over completely —
// there is no per-connection concept on Kanban's side anymore.
router.use(authenticate);

router.get('/status', remoteServerController.getStatus);
router.get('/session', remoteSessionLimiter, remoteServerController.createSession);

export default router;
