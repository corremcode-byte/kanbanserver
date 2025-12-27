"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const emailService_1 = require("../services/emailService");
const responses_1 = require("../utils/responses");
const models_1 = require("../models");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.post('/test-email', async (req, res) => {
    try {
        const { to } = req.body;
        if (!to || typeof to !== 'string') {
            return (0, responses_1.errorResponse)(res, 'Recipient email (`to`) is required', 400);
        }
        const result = await emailService_1.emailService.sendTestEmail(to);
        if (!result) {
            return (0, responses_1.internalServerErrorResponse)(res, 'Email service reported failure. Check server logs.');
        }
        return (0, responses_1.successResponse)(res, 'Test email sent successfully');
    }
    catch (error) {
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to send test email');
    }
});
router.post('/make-me-admin', auth_1.authenticate, async (req, res) => {
    try {
        const userId = req.user._id;
        const user = await models_1.User.findByIdAndUpdate(userId, { role: 'admin' }, { new: true });
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        return (0, responses_1.successResponse)(res, 'You are now an admin!', {
            user: {
                id: user._id,
                email: user.email,
                displayName: user.displayName,
                role: user.role,
            },
        });
    }
    catch (error) {
        console.error('Error promoting user to admin:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update user role');
    }
});
exports.default = router;
//# sourceMappingURL=dev.js.map