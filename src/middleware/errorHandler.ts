import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { errorResponse, internalServerErrorResponse, formatMongooseErrors } from '../utils/responses';

// Interface for authenticated requests
interface AuthenticatedRequest extends Request {
  user?: any;
}

// Custom error class
export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Async error handler wrapper
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Handle CastError (Invalid MongoDB ObjectId)
const handleCastError = (error: any): AppError => {
  const message = `Invalid ${error.path}: ${error.value}`;
  return new AppError(message, 400);
};

// Handle Duplicate Key Error (MongoDB duplicate key)
const handleDuplicateKeyError = (error: any): AppError => {
  const field = Object.keys(error.keyValue)[0];
  const value = error.keyValue[field];
  const message = `Duplicate value for field '${field}': ${value}`;
  return new AppError(message, 409);
};

// Handle Validation Error (Mongoose validation)
const handleValidationError = (error: any): AppError => {
  const errors = formatMongooseErrors(error);
  const message = `Validation failed: ${errors.map(err => err.message).join(', ')}`;
  return new AppError(message, 400);
};

// Handle JWT Error
const handleJWTError = (): AppError => {
  return new AppError('Invalid token. Please log in again.', 401);
};

// Handle JWT Expired Error
const handleJWTExpiredError = (): AppError => {
  return new AppError('Token expired. Please log in again.', 401);
};

// Send error response in development
const sendErrorDev = (err: AppError, res: Response): void => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode
  });
};

// Send error response in production
const sendErrorProd = (err: AppError, res: Response): void => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    errorResponse(res, err.message, err.statusCode);
  } else {
    // Programming or other unknown error: don't leak error details
    logger.error('ERROR:', err);
    internalServerErrorResponse(res, 'Something went wrong!');
  }
};

// Global error handling middleware
export const globalErrorHandler = (
  err: any,
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  let error = { ...err };
  error.message = err.message;

  // Set default values
  error.statusCode = error.statusCode || 500;
  error.status = error.status || 'error';

  // Log error
  logger.error('Global Error Handler:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    user: req.user?.id
  });

  // Handle specific error types
  if (error.name === 'CastError') error = handleCastError(error);
  if (error.code === 11000) error = handleDuplicateKeyError(error);
  if (error.name === 'ValidationError') error = handleValidationError(error);
  if (error.name === 'JsonWebTokenError') error = handleJWTError();
  if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();

  // Send error response
  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(error, res);
  } else {
    sendErrorProd(error, res);
  }
};

// 404 handler for undefined routes
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const error = new AppError(`Route ${req.originalUrl} not found`, 404);
  next(error);
};

// Handle unhandled promise rejections
export const handleUnhandledRejections = (): void => {
  process.on('unhandledRejection', (err: Error) => {
    logger.error('UNHANDLED REJECTION! 💥 Shutting down...', err);
    process.exit(1);
  });
};

// Handle uncaught exceptions
export const handleUncaughtExceptions = (): void => {
  process.on('uncaughtException', (err: Error) => {
    logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err);
    process.exit(1);
  });
};

// Graceful shutdown handler
export const handleGracefulShutdown = (server: any): void => {
  // Handle SIGTERM signal
  process.on('SIGTERM', () => {
    logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
    server.close(() => {
      logger.info('💥 Process terminated!');
    });
  });

  // Handle SIGINT signal (Ctrl+C)
  process.on('SIGINT', () => {
    logger.info('👋 SIGINT RECEIVED. Shutting down gracefully');
    server.close(() => {
      logger.info('💥 Process terminated!');
    });
  });
};

// Validation error handler for specific validation libraries
export const handleValidationErrors = (error: any): AppError => {
  if (error.name === 'ValidationError') {
    // Mongoose validation error
    return handleValidationError(error);
  }
  
  if (error.isJoi) {
    // Joi validation error
    const message = error.details.map((detail: any) => detail.message).join(', ');
    return new AppError(`Validation Error: ${message}`, 400);
  }

  return error;
};

// Rate limit error handler
export const handleRateLimitError = (): AppError => {
  return new AppError('Too many requests from this IP, please try again later.', 429);
};

// Database connection error handler
export const handleDatabaseError = (error: any): AppError => {
  if (error.name === 'MongoNetworkError') {
    return new AppError('Database connection failed', 503);
  }
  
  if (error.name === 'MongoTimeoutError') {
    return new AppError('Database operation timed out', 504);
  }

  return new AppError('Database error occurred', 500);
};

export default {
  AppError,
  asyncHandler,
  globalErrorHandler,
  notFoundHandler,
  handleUnhandledRejections,
  handleUncaughtExceptions,
  handleGracefulShutdown,
  handleValidationErrors,
  handleRateLimitError,
  handleDatabaseError
};