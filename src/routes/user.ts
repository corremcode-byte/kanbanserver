import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as usersController from '../controllers/userController';

const router = Router();

router.use(authenticate);
router.get('/', usersController.getUsers);
router.get('/search', usersController.searchUsers);

export default router;
