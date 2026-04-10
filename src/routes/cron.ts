import { Router, Request, Response } from 'express';
import { cronService } from '../services/cronService';
import { emailService } from '../services/emailService';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Manually trigger task deadline check (for testing)
 * GET /api/cron/test-reminders
 */
router.get('/test-reminders', async (req, res) => {
  try {
    logger.info('Manual trigger of task deadline check requested');
    await cronService.manualCheckDeadlines();
    res.json({
      success: true,
      message: 'Task deadline check completed. Check server logs for details.'
    });
  } catch (error) {
    logger.error('Error in manual deadline check:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check deadlines',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Check email service status and optionally send a test email
 * GET  /api/cron/test-email          — shows SMTP status
 * POST /api/cron/test-email          — sends a test email to body.to
 */
router.get('/test-email', async (_req: Request, res: Response) => {
  res.json({ status: emailService.getStatus() });
});

// GET /api/cron/test-email?to=your@email.com
router.get('/test-email/send', async (req: Request, res: Response): Promise<void> => {
  const to = req.query.to as string;
  if (!to) {
    res.status(400).json({ success: false, message: 'Add ?to=your@email.com to the URL' });
    return;
  }
  try {
    const sent = await emailService.sendTestEmail(to);
    res.json({ success: sent, to, status: emailService.getStatus() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: emailService.getStatus()
    });
  }
});

export default router;
