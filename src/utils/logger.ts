import winston from 'winston';
import path from 'path';

// Define log levels
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each log level
const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Add colors to winston
winston.addColors(logColors);

// Create log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    if (info.stack) {
      // If there's a stack trace, include it
      return `${info.timestamp} ${info.level}: ${info.message}\n${info.stack}`;
    }
    return `${info.timestamp} ${info.level}: ${info.message}`;
  })
);

// Create file format (without colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Define which transports the logger will use
const transports: winston.transport[] = [
  // Console transport
  new winston.transports.Console({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
  }),
];

// Add file transports in production (but skip in serverless environments like Vercel)
// Vercel and other serverless platforms don't allow writing to the filesystem
const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTION_NAME;
if (process.env.NODE_ENV === 'production' && !isServerless) {
  try {
    // Ensure logs directory exists
    const fs = require('fs');
    const logsDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    transports.push(
      // All logs - removed 'as any'
      new winston.transports.File({
        filename: path.join(logsDir, 'app.log'),
        level: 'info',
        format: fileFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      }),
      // Error logs - removed 'as any'
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        format: fileFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5,
      })
    );
  } catch (error) {
    // If we can't create file transports (e.g., in serverless), just use console
    console.warn('File logging not available, using console only:', error);
  }
}

// Create the logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: logLevels,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp()
  ),
  transports,
  // Don't exit on handled exceptions
  exitOnError: false,
});

// Handle uncaught exceptions and unhandled rejections
// Skip file transports in serverless environments
if (process.env.NODE_ENV === 'production' && !isServerless) {
  try {
    const fs = require('fs');
    const logsDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    logger.exceptions.handle(
      new winston.transports.File({ 
        filename: path.join(logsDir, 'exceptions.log'),
        format: fileFormat
      })
    );

    logger.rejections.handle(
      new winston.transports.File({ 
        filename: path.join(logsDir, 'rejections.log'),
        format: fileFormat
      })
    );
  } catch (error) {
    // If we can't create file transports, just log to console
    console.warn('Exception/rejection file logging not available:', error);
  }
}

// Create a stream object for Morgan
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};

// Helper functions for structured logging
export const logError = (message: string, error?: any, metadata?: any) => {
  logger.error(message, { error: error?.message || error, stack: error?.stack, ...metadata });
};

export const logInfo = (message: string, metadata?: object) => {
  logger.info(message, metadata);
};

export const logWarn = (message: string, metadata?: object) => {
  logger.warn(message, metadata);
};

export const logDebug = (message: string, metadata?: object) => {
  logger.debug(message, metadata);
};

// Log performance metrics
export const logPerformance = (operation: string, duration: number, metadata?: object) => {
  logger.info(`Performance: ${operation} completed in ${duration}ms`, {
    operation,
    duration,
    ...metadata
  });
};

// Log API requests
export const logApiRequest = (method: string, url: string, statusCode: number, duration: number, userId?: string) => {
  logger.http(`${method} ${url} ${statusCode} - ${duration}ms`, {
    method,
    url,
    statusCode,
    duration,
    userId
  });
};

export default logger;