"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const cronService_1 = require("../services/cronService");
const logger_1 = require("../utils/logger");
const router = (0, express_1.Router)();
router.get('/test-reminders', async (req, res) => {
    try {
        logger_1.logger.info('Manual trigger of task deadline check requested');
        await cronService_1.cronService.manualCheckDeadlines();
        res.json({
            success: true,
            message: 'Task deadline check completed. Check server logs for details.'
        });
    }
    catch (error) {
        logger_1.logger.error('Error in manual deadline check:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check deadlines',
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
exports.default = router;
//# sourceMappingURL=cron.js.map