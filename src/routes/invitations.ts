import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as invitationsController from '../controllers/invitationsController';

const router = Router();

// ===== PUBLIC ROUTES (no auth required) =====
// Get invitation by token
router.get('/token/:token', invitationsController.getInvitationByToken);

// Accept invitation (user needs to accept BEFORE signing in)
router.post('/:token/accept', invitationsController.acceptInvitation);

// Reject invitation
router.post('/:token/reject', invitationsController.rejectInvitation);

// ===== PROTECTED ROUTES (auth required) =====
// Apply authentication middleware to routes below this line
router.use(authenticate);

// Complete invitation after user signs in
router.post('/complete', invitationsController.completeInvitation);

// Send invitation
router.post('/', invitationsController.sendInvitation);

// Get user's pending invitations
router.get('/my-invitations', invitationsController.getUserInvitations);

// Get project invitations
router.get('/project/:projectId', invitationsController.getProjectInvitations);

// Cancel invitation (for project owners)
router.delete('/:invitationId', invitationsController.cancelInvitation);

// Resend invitation
router.post('/:invitationId/resend', invitationsController.resendInvitation);

export default router;