import { Router } from 'express';
import { cronService } from '../services/cronService';
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

export default router;
