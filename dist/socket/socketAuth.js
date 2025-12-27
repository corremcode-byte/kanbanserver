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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canJoinRoom = exports.getSocketUserId = exports.socketAuth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const models_1 = require("../models");
const logger_1 = require("../utils/logger");
const socketAuth = async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) {
            logger_1.logger.warn('Socket connection attempted without token');
            return next(new Error('Authentication token required'));
        }
        const secret = process.env.JWT_SECRET || 'your-default-secret';
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        if (!decoded || !decoded.id) {
            logger_1.logger.warn('Invalid token provided for socket connection');
            return next(new Error('Invalid token'));
        }
        const user = await models_1.User.findById(decoded.id);
        if (!user) {
            logger_1.logger.warn(`Socket connection attempted for non-existent user: ${decoded.id}`);
            return next(new Error('User not found'));
        }
        if (!user.isActive) {
            logger_1.logger.warn(`Socket connection attempted for inactive user: ${user.email}`);
            return next(new Error('Account is deactivated'));
        }
        socket.user = user;
        logger_1.logger.info(`Socket authenticated for user: ${user.email}`);
        next();
    }
    catch (error) {
        logger_1.logger.error('Socket authentication failed:', error);
        next(new Error('Authentication failed'));
    }
};
exports.socketAuth = socketAuth;
const getSocketUserId = (socket) => {
    return socket.user?._id?.toString() || null;
};
exports.getSocketUserId = getSocketUserId;
const canJoinRoom = async (socket, roomType, roomId) => {
    try {
        const userId = (0, exports.getSocketUserId)(socket);
        if (!userId)
            return false;
        switch (roomType) {
            case 'project': {
                const { Project } = await Promise.resolve().then(() => __importStar(require('../models')));
                const project = await Project.findById(roomId);
                if (!project)
                    return false;
                return project.ownerId.toString() === userId ||
                    project.members.some((member) => member.toString() === userId);
            }
            case 'user': {
                return roomId === userId;
            }
            default:
                return false;
        }
    }
    catch (error) {
        logger_1.logger.error(`Error checking room access for ${roomType}:${roomId}:`, error);
        return false;
    }
};
exports.canJoinRoom = canJoinRoom;
exports.default = {
    socketAuth: exports.socketAuth,
    getSocketUserId: exports.getSocketUserId,
    canJoinRoom: exports.canJoinRoom
};
//# sourceMappingURL=socketAuth.js.map