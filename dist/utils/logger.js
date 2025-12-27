"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logApiRequest = exports.logPerformance = exports.logDebug = exports.logWarn = exports.logInfo = exports.logError = exports.morganStream = exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
const logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};
const logColors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};
winston_1.default.addColors(logColors);
const logFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }), winston_1.default.format.colorize({ all: true }), winston_1.default.format.printf((info) => {
    if (info.stack) {
        return `${info.timestamp} ${info.level}: ${info.message}\n${info.stack}`;
    }
    return `${info.timestamp} ${info.level}: ${info.message}`;
}));
const fileFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json());
const transports = [
    new winston_1.default.transports.Console({
        level: process.env.LOG_LEVEL || 'info',
        format: logFormat,
    }),
];
const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTION_NAME;
if (process.env.NODE_ENV === 'production' && !isServerless) {
    try {
        const fs = require('fs');
        const logsDir = path_1.default.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        transports.push(new winston_1.default.transports.File({
            filename: path_1.default.join(logsDir, 'app.log'),
            level: 'info',
            format: fileFormat,
            maxsize: 10485760,
            maxFiles: 5,
        }), new winston_1.default.transports.File({
            filename: path_1.default.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 10485760,
            maxFiles: 5,
        }));
    }
    catch (error) {
        console.warn('File logging not available, using console only:', error);
    }
}
exports.logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels: logLevels,
    format: winston_1.default.format.combine(winston_1.default.format.errors({ stack: true }), winston_1.default.format.timestamp()),
    transports,
    exitOnError: false,
});
if (process.env.NODE_ENV === 'production' && !isServerless) {
    try {
        const fs = require('fs');
        const logsDir = path_1.default.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        exports.logger.exceptions.handle(new winston_1.default.transports.File({
            filename: path_1.default.join(logsDir, 'exceptions.log'),
            format: fileFormat
        }));
        exports.logger.rejections.handle(new winston_1.default.transports.File({
            filename: path_1.default.join(logsDir, 'rejections.log'),
            format: fileFormat
        }));
    }
    catch (error) {
        console.warn('Exception/rejection file logging not available:', error);
    }
}
exports.morganStream = {
    write: (message) => {
        exports.logger.http(message.trim());
    },
};
const logError = (message, error, metadata) => {
    exports.logger.error(message, { error: error?.message || error, stack: error?.stack, ...metadata });
};
exports.logError = logError;
const logInfo = (message, metadata) => {
    exports.logger.info(message, metadata);
};
exports.logInfo = logInfo;
const logWarn = (message, metadata) => {
    exports.logger.warn(message, metadata);
};
exports.logWarn = logWarn;
const logDebug = (message, metadata) => {
    exports.logger.debug(message, metadata);
};
exports.logDebug = logDebug;
const logPerformance = (operation, duration, metadata) => {
    exports.logger.info(`Performance: ${operation} completed in ${duration}ms`, {
        operation,
        duration,
        ...metadata
    });
};
exports.logPerformance = logPerformance;
const logApiRequest = (method, url, statusCode, duration, userId) => {
    exports.logger.http(`${method} ${url} ${statusCode} - ${duration}ms`, {
        method,
        url,
        statusCode,
        duration,
        userId
    });
};
exports.logApiRequest = logApiRequest;
exports.default = exports.logger;
//# sourceMappingURL=logger.js.map