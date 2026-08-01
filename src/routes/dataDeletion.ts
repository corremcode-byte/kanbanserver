import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import {
  getDataDeletionStatus,
  setDataDeletionPassword,
  verifyDataDeletionPassword,
  executeDataWipe,
} from '../controllers/dataDeletionController';

const router = Router();

router.use(authenticate, requireSuperAdmin);

router.get('/status', getDataDeletionStatus);
router.post('/password', setDataDeletionPassword);
router.post('/verify-password', verifyDataDeletionPassword);
router.post('/execute', executeDataWipe);

export default router;
