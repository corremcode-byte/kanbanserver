"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const mongoose_1 = __importDefault(require("mongoose"));
const User_1 = require("../models/User");
const logger_1 = require("../utils/logger");
dotenv_1.default.config();
const addUniqueDisplayNameIndex = async () => {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kanban';
        logger_1.logger.info(`Connecting to MongoDB...`);
        await mongoose_1.default.connect(mongoUri);
        logger_1.logger.info('Connected to MongoDB');
        const users = await User_1.User.find({});
        const displayNameCounts = new Map();
        for (const user of users) {
            const count = displayNameCounts.get(user.displayName) || 0;
            displayNameCounts.set(user.displayName, count + 1);
        }
        const duplicates = Array.from(displayNameCounts.entries())
            .filter(([_, count]) => count > 1)
            .map(([name, _]) => name);
        if (duplicates.length > 0) {
            logger_1.logger.info(`Found ${duplicates.length} duplicate displayNames. Fixing...`);
            for (const duplicateName of duplicates) {
                const duplicateUsers = await User_1.User.find({ displayName: duplicateName }).sort({ createdAt: 1 });
                for (let i = 1; i < duplicateUsers.length; i++) {
                    const newDisplayName = `${duplicateName}_${i}`;
                    logger_1.logger.info(`Renaming user ${duplicateUsers[i].email} from "${duplicateName}" to "${newDisplayName}"`);
                    duplicateUsers[i].displayName = newDisplayName;
                    await duplicateUsers[i].save();
                }
            }
            logger_1.logger.info('All duplicate displayNames have been fixed');
        }
        else {
            logger_1.logger.info('No duplicate displayNames found');
        }
        try {
            await User_1.User.collection.dropIndex('displayName_1');
            logger_1.logger.info('Dropped old displayName index');
        }
        catch (error) {
            logger_1.logger.info('No existing displayName index to drop');
        }
        await User_1.User.collection.createIndex({ displayName: 1 }, { unique: true });
        logger_1.logger.info('Created unique index on displayName field');
        const indexes = await User_1.User.collection.indexes();
        const displayNameIndex = indexes.find(idx => idx.key && idx.key.displayName === 1);
        if (displayNameIndex && displayNameIndex.unique) {
            logger_1.logger.info('✅ Unique index on displayName verified successfully');
        }
        else {
            logger_1.logger.warn('⚠️ Unique index may not have been created correctly');
        }
        await mongoose_1.default.disconnect();
        logger_1.logger.info('Migration completed successfully');
        process.exit(0);
    }
    catch (error) {
        logger_1.logger.error('Migration failed:', error);
        await mongoose_1.default.disconnect();
        process.exit(1);
    }
};
addUniqueDisplayNameIndex();
//# sourceMappingURL=addUniqueDisplayNameIndex.js.map