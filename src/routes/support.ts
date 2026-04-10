import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  getAllTickets,
  getTicket,
  createTicket,
  addReply,
  updateStatus,
} from '../controllers/supportController';

const router = Router();

router.use(authenticate);

router.get('/tickets', getAllTickets);
router.get('/tickets/:id', getTicket);
router.post('/tickets', createTicket);
router.post('/tickets/:id/replies', addReply);
router.patch('/tickets/:id/status', updateStatus);

export default router;
