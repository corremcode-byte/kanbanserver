import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { remoteConnectLimiter } from '../middleware/rateLimiter';
import * as remoteWorkspaceController from '../controllers/remoteWorkspaceController';

const router = Router();

router.use(authenticate);

router.post('/connect', remoteConnectLimiter, remoteWorkspaceController.connect);

export default router;
