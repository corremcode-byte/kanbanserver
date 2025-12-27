"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserById = exports.searchUsers = exports.getUsers = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const getUsers = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const users = await models_1.User.find({ isActive: true })
            .select('name email avatar createdAt')
            .sort({ name: 1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum);
        const total = await models_1.User.countDocuments({ isActive: true });
        return (0, responses_1.successResponse)(res, 'Users retrieved successfully', {
            users,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting users:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get users');
    }
};
exports.getUsers = getUsers;
const searchUsers = async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        if (!q || typeof q !== 'string' || q.trim().length < 2) {
            return (0, responses_1.errorResponse)(res, 'Search query must be at least 2 characters', 400);
        }
        const users = await models_1.User.searchUsers(q.trim(), parseInt(limit));
        return (0, responses_1.successResponse)(res, 'Users found', users);
    }
    catch (error) {
        logger_1.logger.error('Error searching users:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to search users');
    }
};
exports.searchUsers = searchUsers;
const getUserById = async (req, res) => {
    try {
        const { id } = req.params;
        const user = await models_1.User.findById(id)
            .select('name email avatar createdAt')
            .where({ isActive: true });
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        return (0, responses_1.successResponse)(res, 'User retrieved successfully', user);
    }
    catch (error) {
        logger_1.logger.error('Error getting user by ID:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get user');
    }
};
exports.getUserById = getUserById;
//# sourceMappingURL=userController.js.map