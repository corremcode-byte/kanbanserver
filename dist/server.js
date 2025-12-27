"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const mongoose_1 = __importDefault(require("mongoose"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const socket_1 = require("./socket");
const routes_1 = __importDefault(require("./routes"));
const middleware_1 = require("./middleware");
const logger_1 = require("./utils/logger");
const cronService_1 = require("./services/cronService");
dotenv_1.default.config();
const app = (0, express_1.default)();
exports.app = app;
const server = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3001'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        credentials: true
    }
});
exports.io = io;
(0, socket_1.initializeSocket)(io);
app.use((0, cors_1.default)({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3001'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 600
}));
app.use((0, helmet_1.default)());
app.use((0, compression_1.default)());
app.use((0, cookie_parser_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
app.use('/api', routes_1.default);
app.use(middleware_1.errorHandler);
const connectDB = async () => {
    try {
        const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/asana-clone';
        await mongoose_1.default.connect(mongoURI);
        logger_1.logger.info('MongoDB connected successfully');
    }
    catch (error) {
        logger_1.logger.error('MongoDB connection failed:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
};
const PORT = process.env.PORT || 4001;
const startServer = async () => {
    try {
        await connectDB();
        cronService_1.cronService.start();
        server.listen(PORT, () => {
            logger_1.logger.info(`Server running on port ${PORT}`);
            logger_1.logger.info(`Health check: http://localhost:${PORT}/health`);
            logger_1.logger.info(`API endpoint: http://localhost:${PORT}/api`);
            logger_1.logger.info(`Socket.IO enabled: ws://localhost:${PORT}`);
            logger_1.logger.info(`Cron jobs started`);
        });
    }
    catch (error) {
        logger_1.logger.error('Failed to start server:', error);
        process.exit(1);
    }
};
process.on('SIGTERM', async () => {
    logger_1.logger.info('SIGTERM signal received: closing HTTP server');
    cronService_1.cronService.stop();
    server.close(async () => {
        logger_1.logger.info('HTTP server closed');
        await mongoose_1.default.connection.close();
        logger_1.logger.info('MongoDB connection closed');
        process.exit(0);
    });
});
process.on('SIGINT', async () => {
    logger_1.logger.info('SIGINT signal received: closing HTTP server');
    cronService_1.cronService.stop();
    server.close(async () => {
        logger_1.logger.info('HTTP server closed');
        await mongoose_1.default.connection.close();
        logger_1.logger.info('MongoDB connection closed');
        process.exit(0);
    });
});
startServer();
//# sourceMappingURL=server.js.map