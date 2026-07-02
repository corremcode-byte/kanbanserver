import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { getSearchAccessCode, updateSearchAccessCode, verifySearchAccessCode } from '../controllers/systemSettingsController';

const router = Router();

// Super-admin only: view/update the raw access code
router.get('/search-access-code', authenticate, requireSuperAdmin, getSearchAccessCode);
router.put('/search-access-code', authenticate, requireSuperAdmin, updateSearchAccessCode);

// Public: verify a candidate code without ever exposing the stored value
router.post('/search-access-code/verify', verifySearchAccessCode);

export default router;
