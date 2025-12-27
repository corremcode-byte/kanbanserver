"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.createRateLimiter = exports.uploadLimiter = exports.createLimiter = exports.authLimiter = exports.generalLimiter = exports.handleGracefulShutdown = exports.handleUncaughtExceptions = exports.handleUnhandledRejections = exports.notFoundHandler = exports.globalErrorHandler = exports.asyncHandler = exports.AppError = exports.validateObjectId = exports.validatePagination = exports.validateTaskUpdate = exports.validateTaskCreate = exports.validateProjectUpdate = exports.validateProjectCreate = exports.validateTeamUpdate = exports.validateTeamCreate = exports.validateUserUpdate = exports.validate = exports.authenticateFirebaseToken = exports.requireAdmin = exports.requireManagerOrAdmin = exports.requireOwnershipOrAdmin = exports.getCurrentUserId = exports.requireEmailVerified = exports.requireActiveUser = exports.authorize = exports.optionalAuth = exports.authenticate = void 0;
__exportStar(require("./auth"), exports);
__exportStar(require("./validation"), exports);
__exportStar(require("./errorHandler"), exports);
__exportStar(require("./rateLimiter"), exports);
__exportStar(require("./permissions"), exports);
var auth_1 = require("./auth");
Object.defineProperty(exports, "authenticate", { enumerable: true, get: function () { return auth_1.authenticate; } });
Object.defineProperty(exports, "optionalAuth", { enumerable: true, get: function () { return auth_1.optionalAuth; } });
Object.defineProperty(exports, "authorize", { enumerable: true, get: function () { return auth_1.authorize; } });
Object.defineProperty(exports, "requireActiveUser", { enumerable: true, get: function () { return auth_1.requireActiveUser; } });
Object.defineProperty(exports, "requireEmailVerified", { enumerable: true, get: function () { return auth_1.requireEmailVerified; } });
Object.defineProperty(exports, "getCurrentUserId", { enumerable: true, get: function () { return auth_1.getCurrentUserId; } });
Object.defineProperty(exports, "requireOwnershipOrAdmin", { enumerable: true, get: function () { return auth_1.requireOwnershipOrAdmin; } });
Object.defineProperty(exports, "requireManagerOrAdmin", { enumerable: true, get: function () { return auth_1.requireManagerOrAdmin; } });
Object.defineProperty(exports, "requireAdmin", { enumerable: true, get: function () { return auth_1.requireAdmin; } });
Object.defineProperty(exports, "authenticateFirebaseToken", { enumerable: true, get: function () { return auth_1.authenticateFirebaseToken; } });
var validation_1 = require("./validation");
Object.defineProperty(exports, "validate", { enumerable: true, get: function () { return validation_1.validate; } });
Object.defineProperty(exports, "validateUserUpdate", { enumerable: true, get: function () { return validation_1.validateUserUpdate; } });
Object.defineProperty(exports, "validateTeamCreate", { enumerable: true, get: function () { return validation_1.validateTeamCreate; } });
Object.defineProperty(exports, "validateTeamUpdate", { enumerable: true, get: function () { return validation_1.validateTeamUpdate; } });
Object.defineProperty(exports, "validateProjectCreate", { enumerable: true, get: function () { return validation_1.validateProjectCreate; } });
Object.defineProperty(exports, "validateProjectUpdate", { enumerable: true, get: function () { return validation_1.validateProjectUpdate; } });
Object.defineProperty(exports, "validateTaskCreate", { enumerable: true, get: function () { return validation_1.validateTaskCreate; } });
Object.defineProperty(exports, "validateTaskUpdate", { enumerable: true, get: function () { return validation_1.validateTaskUpdate; } });
Object.defineProperty(exports, "validatePagination", { enumerable: true, get: function () { return validation_1.validatePagination; } });
Object.defineProperty(exports, "validateObjectId", { enumerable: true, get: function () { return validation_1.validateObjectId; } });
var errorHandler_1 = require("./errorHandler");
Object.defineProperty(exports, "AppError", { enumerable: true, get: function () { return errorHandler_1.AppError; } });
Object.defineProperty(exports, "asyncHandler", { enumerable: true, get: function () { return errorHandler_1.asyncHandler; } });
Object.defineProperty(exports, "globalErrorHandler", { enumerable: true, get: function () { return errorHandler_1.globalErrorHandler; } });
Object.defineProperty(exports, "notFoundHandler", { enumerable: true, get: function () { return errorHandler_1.notFoundHandler; } });
Object.defineProperty(exports, "handleUnhandledRejections", { enumerable: true, get: function () { return errorHandler_1.handleUnhandledRejections; } });
Object.defineProperty(exports, "handleUncaughtExceptions", { enumerable: true, get: function () { return errorHandler_1.handleUncaughtExceptions; } });
Object.defineProperty(exports, "handleGracefulShutdown", { enumerable: true, get: function () { return errorHandler_1.handleGracefulShutdown; } });
var rateLimiter_1 = require("./rateLimiter");
Object.defineProperty(exports, "generalLimiter", { enumerable: true, get: function () { return rateLimiter_1.generalLimiter; } });
Object.defineProperty(exports, "authLimiter", { enumerable: true, get: function () { return rateLimiter_1.authLimiter; } });
Object.defineProperty(exports, "createLimiter", { enumerable: true, get: function () { return rateLimiter_1.createLimiter; } });
Object.defineProperty(exports, "uploadLimiter", { enumerable: true, get: function () { return rateLimiter_1.uploadLimiter; } });
Object.defineProperty(exports, "createRateLimiter", { enumerable: true, get: function () { return rateLimiter_1.createRateLimiter; } });
var errorHandler_2 = require("./errorHandler");
Object.defineProperty(exports, "errorHandler", { enumerable: true, get: function () { return errorHandler_2.globalErrorHandler; } });
//# sourceMappingURL=index.js.map