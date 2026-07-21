import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { remoteSessionLimiter } from '../middleware/rateLimiter';
import * as remoteServerController from '../controllers/remoteServerController';

const router = Router();

// Access to the module is gated by the remoteWorkspace module permission,
// checked inside the controller. Guacamole itself is reverse-proxied
// directly by nginx (unguarded) — Kanban's only role is deciding whether to
// show/hand back the Connect link, not controlling access to it at the
// network level. See remoteServerController's doc comment.
router.use(authenticate);

router.get('/status', remoteServerController.getStatus);
router.get('/session', remoteSessionLimiter, remoteServerController.createSession);

export default router;
