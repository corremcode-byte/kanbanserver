import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as remoteWorkspaceController from '../controllers/remoteWorkspaceController';

const router = Router();

// All routes require Kanban authentication — access to the module itself is
// further restricted inside the controller via the remoteWorkspace permission.
router.use(authenticate);

router.get('/', remoteWorkspaceController.getWorkspace);
router.get('/status', remoteWorkspaceController.getStatus);
router.post('/connect', remoteWorkspaceController.connect);
router.post('/disconnect', remoteWorkspaceController.disconnect);

export default router;
