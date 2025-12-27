"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDatabaseError = exports.handleRateLimitError = exports.handleValidationErrors = exports.handleGracefulShutdown = exports.handleUncaughtExceptions = exports.handleUnhandledRejections = exports.notFoundHandler = exports.globalErrorHandler = exports.asyncHandler = exports.AppError = void 0;
const logger_1 = require("../utils/logger");
const responses_1 = require("../utils/responses");
class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
exports.asyncHandler = asyncHandler;
const handleCastError = (error) => {
    const message = `Invalid ${error.path}: ${error.value}`;
    return new AppError(message, 400);
};
const handleDuplicateKeyError = (error) => {
    const field = Object.keys(error.keyValue)[0];
    const value = error.keyValue[field];
    const message = `Duplicate value for field '${field}': ${value}`;
    return new AppError(message, 409);
};
const handleValidationError = (error) => {
    const errors = (0, responses_1.formatMongooseErrors)(error);
    const message = `Validation failed: ${errors.map(err => err.message).join(', ')}`;
    return new AppError(message, 400);
};
const handleJWTError = () => {
    return new AppError('Invalid token. Please log in again.', 401);
};
const handleJWTExpiredError = () => {
    return new AppError('Token expired. Please log in again.', 401);
};
const sendErrorDev = (err, res) => {
    res.status(err.statusCode || 500).json({
        success: false,
        message: err.message,
        stack: err.stack,
        statusCode: err.statusCode
    });
};
const sendErrorProd = (err, res) => {
    if (err.isOperational) {
        (0, responses_1.errorResponse)(res, err.message, err.statusCode);
    }
    else {
        logger_1.logger.error('ERROR:', err);
        (0, responses_1.internalServerErrorResponse)(res, 'Something went wrong!');
    }
};
const globalErrorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;
    error.statusCode = error.statusCode || 500;
    error.status = error.status || 'error';
    logger_1.logger.error('Global Error Handler:', {
        message: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        user: req.user?.id
    });
    if (error.name === 'CastError')
        error = handleCastError(error);
    if (error.code === 11000)
        error = handleDuplicateKeyError(error);
    if (error.name === 'ValidationError')
        error = handleValidationError(error);
    if (error.name === 'JsonWebTokenError')
        error = handleJWTError();
    if (error.name === 'TokenExpiredError')
        error = handleJWTExpiredError();
    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(error, res);
    }
    else {
        sendErrorProd(error, res);
    }
};
exports.globalErrorHandler = globalErrorHandler;
const notFoundHandler = (req, res, next) => {
    const error = new AppError(`Route ${req.originalUrl} not found`, 404);
    next(error);
};
exports.notFoundHandler = notFoundHandler;
const handleUnhandledRejections = () => {
    process.on('unhandledRejection', (err) => {
        logger_1.logger.error('UNHANDLED REJECTION! 💥 Shutting down...', err);
        process.exit(1);
    });
};
exports.handleUnhandledRejections = handleUnhandledRejections;
const handleUncaughtExceptions = () => {
    process.on('uncaughtException', (err) => {
        logger_1.logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err);
        process.exit(1);
    });
};
exports.handleUncaughtExceptions = handleUncaughtExceptions;
const handleGracefulShutdown = (server) => {
    process.on('SIGTERM', () => {
        logger_1.logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
        server.close(() => {
            logger_1.logger.info('💥 Process terminated!');
        });
    });
    process.on('SIGINT', () => {
        logger_1.logger.info('👋 SIGINT RECEIVED. Shutting down gracefully');
        server.close(() => {
            logger_1.logger.info('💥 Process terminated!');
        });
    });
};
exports.handleGracefulShutdown = handleGracefulShutdown;
const handleValidationErrors = (error) => {
    if (error.name === 'ValidationError') {
        return handleValidationError(error);
    }
    if (error.isJoi) {
        const message = error.details.map((detail) => detail.message).join(', ');
        return new AppError(`Validation Error: ${message}`, 400);
    }
    return error;
};
exports.handleValidationErrors = handleValidationErrors;
const handleRateLimitError = () => {
    return new AppError('Too many requests from this IP, please try again later.', 429);
};
exports.handleRateLimitError = handleRateLimitError;
const handleDatabaseError = (error) => {
    if (error.name === 'MongoNetworkError') {
        return new AppError('Database connection failed', 503);
    }
    if (error.name === 'MongoTimeoutError') {
        return new AppError('Database operation timed out', 504);
    }
    return new AppError('Database error occurred', 500);
};
exports.handleDatabaseError = handleDatabaseError;
exports.default = {
    AppError,
    asyncHandler: exports.asyncHandler,
    globalErrorHandler: exports.globalErrorHandler,
    notFoundHandler: exports.notFoundHandler,
    handleUnhandledRejections: exports.handleUnhandledRejections,
    handleUncaughtExceptions: exports.handleUncaughtExceptions,
    handleGracefulShutdown: exports.handleGracefulShutdown,
    handleValidationErrors: exports.handleValidationErrors,
    handleRateLimitError: exports.handleRateLimitError,
    handleDatabaseError: exports.handleDatabaseError
};
//# sourceMappingURL=errorHandler.js.map