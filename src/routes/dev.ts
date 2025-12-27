import { Router } from 'express';
import { emailService } from '../services/emailService';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { User } from '../models';
import { authenticate } from '../middleware/auth';

const router = Router();

// Dev-only endpoint to test email configuration quickly
router.post('/test-email', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to || typeof to !== 'string') {
      return errorResponse(res, 'Recipient email (`to`) is required', 400);
    }

    const result = await emailService.sendTestEmail(to);
    if (!result) {
      return internalServerErrorResponse(res, 'Email service reported failure. Check server logs.');
    }

    return successResponse(res, 'Test email sent successfully');
  } catch (error) {
    return internalServerErrorResponse(res, 'Failed to send test email');
  }
});

// Dev-only endpoint to promote current user to admin role
// WARNING: Remove this endpoint in production!
router.post('/make-me-admin', authenticate, async (req: any, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findByIdAndUpdate(
      userId,
      { role: 'admin' },
      { new: true }
    );

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    return successResponse(res, 'You are now an admin!', {
      user: {
        id: user._id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Error promoting user to admin:', error);
    return internalServerErrorResponse(res, 'Failed to update user role');
  }
});

export default router;
