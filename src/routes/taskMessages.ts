import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as ctrl from '../controllers/taskMessagesController';

const router = Router();
router.use(authenticate);

router.get('/:taskId',        ctrl.getMessages);
router.post('/:taskId',       ctrl.sendMessage);
router.delete('/:messageId',  ctrl.deleteMessage);

export default router;
