"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDatabaseStats = exports.checkDatabaseHealth = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const logger_1 = require("../utils/logger");
const connectDB = async () => {
    try {
        const mongoURI = process.env.MONGODB_URI;
        if (!mongoURI) {
            console.warn('⚠️  MONGODB_URI not set - MongoDB connection skipped (MySQL migration needed)');
            return;
        }
        const options = {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            family: 4,
            retryWrites: true,
            autoIndex: process.env.NODE_ENV === 'development',
        };
        await mongoose_1.default.connect(mongoURI, options);
        logger_1.logger.info('🚀 MongoDB connected successfully');
        mongoose_1.default.connection.on('error', (error) => {
            logger_1.logger.error('MongoDB connection error:', error);
        });
        mongoose_1.default.connection.on('disconnected', () => {
            logger_1.logger.warn('MongoDB disconnected');
        });
        mongoose_1.default.connection.on('reconnected', () => {
            logger_1.logger.info('MongoDB reconnected');
        });
        process.on('SIGINT', async () => {
            try {
                await mongoose_1.default.connection.close();
                logger_1.logger.info('MongoDB connection closed due to application termination');
                process.exit(0);
            }
            catch (error) {
                logger_1.logger.error('Error during database disconnection:', error);
                process.exit(1);
            }
        });
    }
    catch (error) {
        logger_1.logger.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
};
const checkDatabaseHealth = async () => {
    try {
        const state = mongoose_1.default.connection.readyState;
        return state === 1;
    }
    catch (error) {
        logger_1.logger.error('Database health check failed:', error);
        return false;
    }
};
exports.checkDatabaseHealth = checkDatabaseHealth;
const getDatabaseStats = async () => {
    try {
        const stats = await mongoose_1.default.connection.db.stats();
        return {
            database: mongoose_1.default.connection.name,
            collections: stats.collections,
            documents: stats.objects,
            storageSize: stats.storageSize,
            indexSize: stats.indexSize,
            dataSize: stats.dataSize
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to get database stats:', error);
        return null;
    }
};
exports.getDatabaseStats = getDatabaseStats;
exports.default = connectDB;
//# sourceMappingURL=database.js.map