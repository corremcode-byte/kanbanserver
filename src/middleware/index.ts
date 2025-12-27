// Export all middleware
export * from './auth';
export * from './validation';
export * from './errorHandler';
export * from './rateLimiter';
export * from './permissions';

// Re-export common middleware configurations
export {
  authenticate,
  optionalAuth,
  authorize,
  requireActiveUser,
  requireEmailVerified,
  getCurrentUserId,
  requireOwnershipOrAdmin,
  requireManagerOrAdmin,
  requireAdmin,
  authenticateFirebaseToken
} from './auth';

export {
  validate,
  validateUserUpdate,
  validateTeamCreate,
  validateTeamUpdate,
  validateProjectCreate,
  validateProjectUpdate,
  validateTaskCreate,
  validateTaskUpdate,
  validatePagination,
  validateObjectId
} from './validation';

export {
  AppError,
  asyncHandler,
  globalErrorHandler,
  notFoundHandler,
  handleUnhandledRejections,
  handleUncaughtExceptions,
  handleGracefulShutdown
} from './errorHandler';

export {
  generalLimiter,
  authLimiter,
  createLimiter,
  uploadLimiter,
  createRateLimiter
} from './rateLimiter';

export { globalErrorHandler as errorHandler } from './errorHandler';