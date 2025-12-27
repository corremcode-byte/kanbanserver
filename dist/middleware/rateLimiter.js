"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimiter = exports.exportLimiter = exports.searchLimiter = exports.emailVerificationLimiter = exports.passwordResetLimiter = exports.uploadLimiter = exports.createLimiter = exports.authLimiter = exports.generalLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const rateLimitHandler = (req, res) => {
    logger_1.logger.warn(`Rate limit exceeded for IP: ${req.ip}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        url: req.url,
        method: req.method
    });
    (0, responses_1.tooManyRequestsResponse)(res, 'Too many requests from this IP, please try again later.');
};
exports.generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
    message: {
        success: false,
        message: 'Too many requests from this IP, please try again later.',
        error: 'Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        return req.path === '/health' || req.path === '/api/health';
    }
});
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Too many authentication attempts, please try again later.',
        error: 'Authentication Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
});
exports.createLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    message: {
        success: false,
        message: 'Too many create/update requests, please slow down.',
        error: 'Create Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
exports.uploadLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 10,
    message: {
        success: false,
        message: 'Too many file uploads, please wait before uploading again.',
        error: 'Upload Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
exports.passwordResetLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: {
        success: false,
        message: 'Too many password reset attempts, please try again later.',
        error: 'Password Reset Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
exports.emailVerificationLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Too many email verification attempts, please try again later.',
        error: 'Email Verification Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        success: false,
        message: 'Too many search requests, please slow down.',
        error: 'Search Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
exports.exportLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Too many export requests, please try again later.',
        error: 'Export Rate Limit Exceeded'
    },
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false
});
const createRateLimiter = (windowMs, max, message) => {
    return (0, express_rate_limit_1.default)({
        windowMs,
        max,
        message: {
            success: false,
            message,
            error: 'Rate Limit Exceeded'
        },
        handler: rateLimitHandler,
        standardHeaders: true,
        legacyHeaders: false
    });
};
exports.createRateLimiter = createRateLimiter;
exports.default = {
    generalLimiter: exports.generalLimiter,
    authLimiter: exports.authLimiter,
    createLimiter: exports.createLimiter,
    uploadLimiter: exports.uploadLimiter,
    passwordResetLimiter: exports.passwordResetLimiter,
    emailVerificationLimiter: exports.emailVerificationLimiter,
    searchLimiter: exports.searchLimiter,
    exportLimiter: exports.exportLimiter,
    createRateLimiter: exports.createRateLimiter
};
//# sourceMappingURL=rateLimiter.js.map