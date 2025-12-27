"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIO = exports.initializeSocket = void 0;
const socketAuth_1 = require("./socketAuth");
const socketHandlers_1 = require("./socketHandlers");
const logger_1 = require("../utils/logger");
let ioInstance = null;
const initializeSocket = (io) => {
    ioInstance = io;
    logger_1.logger.info('🚀 Initializing Socket.IO server...');
    io.use(socketAuth_1.socketAuth);
    (0, socketHandlers_1.setupSocketHandlers)(io);
    io.engine.on('connection_error', (error) => {
        logger_1.logger.error('❌ Socket.IO connection error:', error);
    });
    io.engine.on('initial_headers', () => {
        logger_1.logger.info('Socket.IO engine ready for connections');
    });
    logger_1.logger.info('✅ Socket.IO initialized successfully - Ready to accept frontend connections');
};
exports.initializeSocket = initializeSocket;
const getIO = () => {
    if (!ioInstance) {
        throw new Error('Socket.IO not initialized. Call initializeSocket first.');
    }
    return ioInstance;
};
exports.getIO = getIO;
//# sourceMappingURL=index.js.map