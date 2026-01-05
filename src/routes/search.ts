import { Router } from 'express';
import { search } from '../controllers/searchController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Search route
router.get('/', authenticate, search);

export default router;
