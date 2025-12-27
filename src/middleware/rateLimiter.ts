import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { tooManyRequestsResponse } from '../utils/responses';
import { logger } from '../utils/logger';

// Custom rate limit handler
const rateLimitHandler = (req: Request, res: Response): void => {
  logger.warn(`Rate limit exceeded for IP: ${req.ip}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    url: req.url,
    method: req.method
  });
  
  tooManyRequestsResponse(
    res, 
    'Too many requests from this IP, please try again later.'
  );
};

// General API rate limiter
export const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    error: 'Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/api/health';
  }
});

// Strict rate limiter for authentication routes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.',
    error: 'Authentication Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Don't count successful requests
});

// Moderate rate limiter for create/update operations
export const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each IP to 20 create requests per minute
  message: {
    success: false,
    message: 'Too many create/update requests, please slow down.',
    error: 'Create Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// File upload rate limiter
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 upload requests per minute
  message: {
    success: false,
    message: 'Too many file uploads, please wait before uploading again.',
    error: 'Upload Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// Password reset rate limiter
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // limit each IP to 3 password reset requests per hour
  message: {
    success: false,
    message: 'Too many password reset attempts, please try again later.',
    error: 'Password Reset Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// Email verification rate limiter
export const emailVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 email verification requests per hour
  message: {
    success: false,
    message: 'Too many email verification attempts, please try again later.',
    error: 'Email Verification Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// Search rate limiter
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 search requests per minute
  message: {
    success: false,
    message: 'Too many search requests, please slow down.',
    error: 'Search Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// Export limiter
export const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 export requests per hour
  message: {
    success: false,
    message: 'Too many export requests, please try again later.',
    error: 'Export Rate Limit Exceeded'
  },
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false
});

// Custom rate limiter factory
export const createRateLimiter = (
  windowMs: number,
  max: number,
  message: string
) => {
  return rateLimit({
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

export default {
  generalLimiter,
  authLimiter,
  createLimiter,
  uploadLimiter,
  passwordResetLimiter,
  emailVerificationLimiter,
  searchLimiter,
  exportLimiter,
  createRateLimiter
};
