"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteUser = exports.updateUserRole = exports.toggleUserActiveStatus = exports.getAllUsers = exports.getUserById = exports.searchUsers = exports.getUsers = void 0;
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
const getAllUsers = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return (0, responses_1.errorResponse)(res, 'Access denied. Only admins can view all users.', 403);
        }
        const users = await models_1.User.find()
            .select('firebaseUid email displayName photoURL role isActive lastLoginAt createdAt')
            .sort({ createdAt: -1 });
        const stats = {
            total: users.length,
            active: users.filter(u => u.isActive).length,
            inactive: users.filter(u => !u.isActive).length,
            admins: users.filter(u => u.role === 'admin').length,
        };
        return (0, responses_1.successResponse)(res, 'All users retrieved successfully', { users, stats });
    }
    catch (error) {
        logger_1.logger.error('Error getting all users:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get users');
    }
};
exports.getAllUsers = getAllUsers;
const toggleUserActiveStatus = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return (0, responses_1.errorResponse)(res, 'Access denied. Only admins can modify user status.', 403);
        }
        const { userId } = req.params;
        const { isActive } = req.body;
        if (userId === req.user._id) {
            return (0, responses_1.errorResponse)(res, 'You cannot modify your own account status.', 400);
        }
        const user = await models_1.User.findById(userId);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        user.isActive = isActive;
        await user.save();
        return (0, responses_1.successResponse)(res, `User ${isActive ? 'activated' : 'deactivated'} successfully`, user);
    }
    catch (error) {
        logger_1.logger.error('Error toggling user active status:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update user status');
    }
};
exports.toggleUserActiveStatus = toggleUserActiveStatus;
const updateUserRole = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return (0, responses_1.errorResponse)(res, 'Access denied. Only admins can modify user roles.', 403);
        }
        const { userId } = req.params;
        const { role } = req.body;
        if (!['admin', 'member'].includes(role)) {
            return (0, responses_1.errorResponse)(res, 'Invalid role. Must be admin or member.', 400);
        }
        if (userId === req.user._id) {
            return (0, responses_1.errorResponse)(res, 'You cannot modify your own role.', 400);
        }
        const user = await models_1.User.findById(userId);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        user.role = role;
        await user.save();
        return (0, responses_1.successResponse)(res, 'User role updated successfully', user);
    }
    catch (error) {
        logger_1.logger.error('Error updating user role:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update user role');
    }
};
exports.updateUserRole = updateUserRole;
const deleteUser = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return (0, responses_1.errorResponse)(res, 'Access denied. Only admins can delete users.', 403);
        }
        const { userId } = req.params;
        if (userId === req.user._id) {
            return (0, responses_1.errorResponse)(res, 'You cannot delete your own account.', 400);
        }
        const user = await models_1.User.findById(userId);
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found', 404);
        }
        await models_1.User.findByIdAndDelete(userId);
        return (0, responses_1.successResponse)(res, 'User deleted successfully', { userId });
    }
    catch (error) {
        logger_1.logger.error('Error deleting user:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete user');
    }
};
exports.deleteUser = deleteUser;
//# sourceMappingURL=userController.js.map