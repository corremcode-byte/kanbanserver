"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestPasswordReset = exports.uploadAvatar = exports.deleteAccount = exports.updatePassword = exports.updateSettings = exports.getSettings = exports.searchUsers = exports.deactivateAccount = exports.getDashboardData = exports.updateUserRole = exports.updateProfile = exports.getProfile = exports.getAllUsers = exports.getUserByFirebaseUid = exports.getCurrentUser = exports.syncFirebaseUser = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const syncFirebaseUser = async (req, res) => {
    try {
        const { firebaseUid, email, displayName, photoURL, role = 'member' } = req.body;
        if (!firebaseUid || !email) {
            return (0, responses_1.errorResponse)(res, 'Firebase UID and email are required', 400);
        }
        let user = await models_1.User.findOne({ firebaseUid });
        if (user) {
            user.displayName = displayName || user.displayName;
            user.photoURL = photoURL || user.photoURL;
            user.email = email;
            user.lastLoginAt = new Date();
            await user.save();
            logger_1.logger.info(`Firebase user synced: ${user.email}`);
            return (0, responses_1.successResponse)(res, 'User synced successfully', user);
        }
        user = await models_1.User.findOne({ email });
        if (user && !user.firebaseUid) {
            user.firebaseUid = firebaseUid;
            user.displayName = displayName || user.displayName;
            user.photoURL = photoURL || user.photoURL;
            user.lastLoginAt = new Date();
            await user.save();
            logger_1.logger.info(`Existing user linked to Firebase: ${user.email}`);
            return (0, responses_1.successResponse)(res, 'User linked successfully', user);
        }
        user = new models_1.User({
            firebaseUid,
            email,
            displayName: displayName || email.split('@')[0],
            photoURL,
            role,
            isActive: true,
            lastLoginAt: new Date()
        });
        await user.save();
        logger_1.logger.info(`New Firebase user created: ${user.email}`);
        return (0, responses_1.successResponse)(res, 'User created successfully', user);
    }
    catch (error) {
        logger_1.logger.error('Firebase user sync error:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to sync user');
    }
};
exports.syncFirebaseUser = syncFirebaseUser;
const getCurrentUser = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        if (!user.isActive) {
            return (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        }
        return (0, responses_1.successResponse)(res, 'User retrieved successfully', user);
    }
    catch (error) {
        logger_1.logger.error('Error getting current user:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get user');
    }
};
exports.getCurrentUser = getCurrentUser;
const getUserByFirebaseUid = async (req, res) => {
    try {
        const { firebaseUid } = req.params;
        if (!firebaseUid) {
            return (0, responses_1.errorResponse)(res, 'Firebase UID is required', 400);
        }
        const user = await models_1.User.findOne({ firebaseUid });
        if (!user) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        if (!user.isActive) {
            return (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        }
        return (0, responses_1.successResponse)(res, 'User retrieved successfully', user);
    }
    catch (error) {
        logger_1.logger.error('Error getting user by Firebase UID:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get user');
    }
};
exports.getUserByFirebaseUid = getUserByFirebaseUid;
const getAllUsers = async (req, res) => {
    try {
        const users = await models_1.User.find({ isActive: true })
            .select('-password')
            .sort({ createdAt: -1 });
        return (0, responses_1.successResponse)(res, 'Users retrieved successfully', users);
    }
    catch (error) {
        logger_1.logger.error('Error getting all users:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get users');
    }
};
exports.getAllUsers = getAllUsers;
const getProfile = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const userId = req.user._id.toString();
        const user = await models_1.User.findById(userId);
        if (!user) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        if (!user.isActive) {
            return (0, responses_1.errorResponse)(res, 'Account is deactivated', 403);
        }
        const taskQuery = {
            $or: [
                { assigneeId: userId },
                { assignedTo: userId },
                { assignees: userId },
                { createdBy: userId }
            ]
        };
        const [totalProjects, totalTasks, completedTasks, activeTasks, overdueTasks] = await Promise.all([
            models_1.Project.countDocuments({ ownerId: userId }),
            models_1.Task.countDocuments(taskQuery),
            models_1.Task.countDocuments({
                ...taskQuery,
                status: 'completed'
            }),
            models_1.Task.countDocuments({
                ...taskQuery,
                status: { $in: ['todo', 'in-progress'] }
            }),
            models_1.Task.countDocuments({
                ...taskQuery,
                status: { $in: ['todo', 'in-progress'] },
                dueDate: { $lt: new Date() }
            })
        ]);
        const recentTasks = await models_1.Task.find(taskQuery)
            .sort({ updatedAt: -1 })
            .limit(10)
            .populate('projectId', 'name');
        const recentProjects = await models_1.Project.find({
            $or: [{ ownerId: userId }, { members: userId }]
        })
            .sort({ updatedAt: -1 })
            .limit(5);
        const recentActivity = [];
        for (const task of recentTasks) {
            const projectName = task.projectId && typeof task.projectId === 'object' && 'name' in task.projectId
                ? task.projectId.name
                : 'Unknown Project';
            if (task.status === 'completed') {
                recentActivity.push({
                    id: task._id.toString(),
                    type: 'task_completed',
                    title: 'Task Completed',
                    description: `Completed "${task.title}" in ${projectName}`,
                    timestamp: task.updatedAt?.toISOString() || new Date().toISOString(),
                    relatedId: task._id.toString(),
                    metadata: {
                        projectName,
                        taskTitle: task.title
                    }
                });
            }
            else if (task.createdBy?.toString() === userId && task.createdAt && new Date().getTime() - new Date(task.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
                recentActivity.push({
                    id: task._id.toString(),
                    type: 'task_assigned',
                    title: 'Task Created',
                    description: `Created "${task.title}" in ${projectName}`,
                    timestamp: task.createdAt?.toISOString() || new Date().toISOString(),
                    relatedId: task._id.toString(),
                    metadata: {
                        projectName,
                        taskTitle: task.title
                    }
                });
            }
        }
        for (const project of recentProjects) {
            if (project.ownerId.toString() === userId && project.createdAt && new Date().getTime() - new Date(project.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
                recentActivity.push({
                    id: project._id.toString(),
                    type: 'project_created',
                    title: 'Project Created',
                    description: `Created project "${project.name}"`,
                    timestamp: project.createdAt?.toISOString() || new Date().toISOString(),
                    relatedId: project._id.toString(),
                    metadata: {
                        projectName: project.name
                    }
                });
            }
        }
        recentActivity.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const profileData = {
            user: {
                ...user.toObject(),
                name: user.displayName,
                stats: {
                    totalBoardsCreated: totalProjects,
                    totalTasksCompleted: completedTasks,
                    activeTasksCount: activeTasks,
                    overdueTasksCount: overdueTasks
                }
            },
            recentActivity: recentActivity.slice(0, 10)
        };
        return (0, responses_1.successResponse)(res, 'Profile retrieved successfully', profileData);
    }
    catch (error) {
        logger_1.logger.error('Error getting profile:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve profile');
    }
};
exports.getProfile = getProfile;
const updateProfile = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const { displayName, bio, photoURL } = req.body;
        const updateData = {};
        if (displayName !== undefined) {
            if (!displayName?.trim()) {
                return (0, responses_1.errorResponse)(res, 'Display name cannot be empty', 400);
            }
            updateData.displayName = displayName.trim();
        }
        if (bio !== undefined) {
            updateData.bio = bio.trim();
        }
        if (photoURL !== undefined) {
            updateData.photoURL = photoURL;
        }
        const updatedUser = await models_1.User.findByIdAndUpdate(req.user._id, updateData, { new: true });
        if (!updatedUser) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        logger_1.logger.info(`Profile updated for user: ${updatedUser.email}`);
        return (0, responses_1.successResponse)(res, 'Profile updated successfully', updatedUser);
    }
    catch (error) {
        logger_1.logger.error('Error updating profile:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update profile');
    }
};
exports.updateProfile = updateProfile;
const updateUserRole = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const { userId } = req.params;
        const { role } = req.body;
        const currentUser = await models_1.User.findById(req.user._id);
        if (!currentUser || !['admin', 'manager'].includes(currentUser.role)) {
            return (0, responses_1.errorResponse)(res, 'Insufficient permissions', 403);
        }
        if (!['admin', 'manager', 'member'].includes(role)) {
            return (0, responses_1.errorResponse)(res, 'Invalid role', 400);
        }
        const updatedUser = await models_1.User.findByIdAndUpdate(userId, { role }, { new: true });
        if (!updatedUser) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        logger_1.logger.info(`User role updated: ${updatedUser.email} -> ${role}`);
        return (0, responses_1.successResponse)(res, 'User role updated successfully', updatedUser);
    }
    catch (error) {
        logger_1.logger.error('Error updating user role:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update user role');
    }
};
exports.updateUserRole = updateUserRole;
const getDashboardData = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const userId = req.user._id.toString();
        const [totalTasks, completedTasks, activeProjects, recentTasks, projects] = await Promise.all([
            models_1.Task.countDocuments({
                $or: [
                    { assigneeId: userId },
                    { assignedTo: userId },
                    { assignees: userId },
                    { createdBy: userId }
                ]
            }),
            models_1.Task.countDocuments({
                $or: [
                    { assigneeId: userId },
                    { assignedTo: userId },
                    { assignees: userId },
                    { createdBy: userId }
                ],
                status: 'completed'
            }),
            models_1.Project.countDocuments({
                $or: [{ ownerId: userId }, { members: userId }, { managers: userId }],
                status: 'active'
            }),
            models_1.Task.find({
                $or: [
                    { assigneeId: userId },
                    { assignedTo: userId },
                    { assignees: userId },
                    { assignedBy: userId },
                    { createdBy: userId }
                ]
            })
                .sort({ updatedAt: -1 })
                .limit(10)
                .populate('projectId', 'name color')
                .populate('assignees', 'name email avatar')
                .populate('assignedTo', 'name email avatar'),
            models_1.Project.find({
                $or: [{ ownerId: userId }, { members: userId }, { managers: userId }],
                status: { $ne: 'archived' }
            })
                .sort({ updatedAt: -1 })
                .limit(10)
                .populate('ownerId', 'name email')
                .populate('members', 'name email')
                .populate('managers', 'name email')
        ]);
        const projectsWithRoles = projects.map(project => {
            const projectObj = project.toObject();
            const userIdStr = userId.toString();
            const ownerIdStr = project.ownerId.toString();
            let userRole = 'member';
            if (ownerIdStr === userIdStr) {
                userRole = 'owner';
            }
            else if (projectObj.managers && projectObj.managers.some((m) => {
                const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
                return managerId === userIdStr;
            })) {
                userRole = 'manager';
            }
            return {
                ...projectObj,
                userRole
            };
        });
        const dashboardData = {
            stats: {
                totalTasks,
                completedTasks,
                activeProjects
            },
            recentTasks,
            projects: projectsWithRoles
        };
        return (0, responses_1.successResponse)(res, 'Dashboard data retrieved successfully', dashboardData);
    }
    catch (error) {
        logger_1.logger.error('Error getting dashboard data:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve dashboard data');
    }
};
exports.getDashboardData = getDashboardData;
const deactivateAccount = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const updatedUser = await models_1.User.findByIdAndUpdate(req.user._id, {
            isActive: false
        }, { new: true });
        if (!updatedUser) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        logger_1.logger.info(`User account deactivated: ${updatedUser.email}`);
        return (0, responses_1.successResponse)(res, 'Account deactivated successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deactivating account:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to deactivate account');
    }
};
exports.deactivateAccount = deactivateAccount;
const searchUsers = async (req, res) => {
    try {
        const { query } = req.query;
        if (!query || typeof query !== 'string') {
            return (0, responses_1.errorResponse)(res, 'Search query is required', 400);
        }
        const users = await models_1.User.find({
            isActive: true,
            $or: [
                { displayName: { $regex: query, $options: 'i' } },
                { email: { $regex: query, $options: 'i' } }
            ]
        })
            .select('_id displayName email photoURL role')
            .limit(10);
        return (0, responses_1.successResponse)(res, 'Users found', users);
    }
    catch (error) {
        logger_1.logger.error('Error searching users:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to search users');
    }
};
exports.searchUsers = searchUsers;
const getSettings = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        const settings = user.settings || {
            appearance: {
                theme: 'system',
                colorScheme: 'blue',
                fontSize: 'medium'
            },
            notifications: {
                emailNotifications: true,
                taskDeadlineReminders: true,
                dailyDigest: false
            },
            boardPreferences: {
                defaultView: 'kanban',
                autoArchiveCompleted: false,
                taskSorting: 'due_date'
            }
        };
        return (0, responses_1.successResponse)(res, 'Settings retrieved successfully', settings);
    }
    catch (error) {
        logger_1.logger.error('Error getting settings:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve settings');
    }
};
exports.getSettings = getSettings;
const updateSettings = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const { appearance, notifications, boardPreferences } = req.body;
        const user = await models_1.User.findById(req.user._id);
        if (!user) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        if (!user.settings) {
            user.settings = {
                appearance: {
                    theme: 'system',
                    colorScheme: 'blue',
                    fontSize: 'medium'
                },
                notifications: {
                    emailNotifications: true,
                    taskDeadlineReminders: true,
                    dailyDigest: false
                },
                boardPreferences: {
                    defaultView: 'kanban',
                    autoArchiveCompleted: false,
                    taskSorting: 'due_date'
                }
            };
        }
        if (appearance) {
            if (!user.settings.appearance) {
                user.settings.appearance = {};
            }
            if (appearance.theme !== undefined) {
                user.settings.appearance.theme = appearance.theme;
            }
            if (appearance.colorScheme !== undefined) {
                user.settings.appearance.colorScheme = appearance.colorScheme;
            }
            if (appearance.fontSize !== undefined) {
                user.settings.appearance.fontSize = appearance.fontSize;
            }
        }
        if (notifications) {
            if (!user.settings.notifications) {
                user.settings.notifications = {};
            }
            if (notifications.emailNotifications !== undefined) {
                user.settings.notifications.emailNotifications = notifications.emailNotifications;
            }
            if (notifications.taskDeadlineReminders !== undefined) {
                user.settings.notifications.taskDeadlineReminders = notifications.taskDeadlineReminders;
            }
            if (notifications.dailyDigest !== undefined) {
                user.settings.notifications.dailyDigest = notifications.dailyDigest;
            }
        }
        if (boardPreferences) {
            if (!user.settings.boardPreferences) {
                user.settings.boardPreferences = {};
            }
            if (boardPreferences.defaultView !== undefined) {
                user.settings.boardPreferences.defaultView = boardPreferences.defaultView;
            }
            if (boardPreferences.autoArchiveCompleted !== undefined) {
                user.settings.boardPreferences.autoArchiveCompleted = boardPreferences.autoArchiveCompleted;
            }
            if (boardPreferences.taskSorting !== undefined) {
                user.settings.boardPreferences.taskSorting = boardPreferences.taskSorting;
            }
        }
        await user.save();
        logger_1.logger.info(`Settings updated for user: ${user.email}`);
        return (0, responses_1.successResponse)(res, 'Settings updated successfully', user.settings);
    }
    catch (error) {
        logger_1.logger.error('Error updating settings:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update settings');
    }
};
exports.updateSettings = updateSettings;
const updatePassword = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        return (0, responses_1.errorResponse)(res, 'Password changes must be done through Firebase authentication. Please use the Firebase password reset feature.', 400);
    }
    catch (error) {
        logger_1.logger.error('Error updating password:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update password');
    }
};
exports.updatePassword = updatePassword;
const deleteAccount = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        const updatedUser = await models_1.User.findByIdAndUpdate(req.user._id, { isActive: false }, { new: true });
        if (!updatedUser) {
            return (0, responses_1.notFoundResponse)(res, 'User not found');
        }
        logger_1.logger.info(`Account deleted/deactivated for user: ${updatedUser.email}`);
        return (0, responses_1.successResponse)(res, 'Account deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting account:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete account');
    }
};
exports.deleteAccount = deleteAccount;
const uploadAvatar = async (req, res) => {
    try {
        if (!req.user?._id) {
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        return (0, responses_1.errorResponse)(res, 'Avatar upload requires file storage configuration (Firebase Storage or AWS S3). Please configure file storage first.', 501);
    }
    catch (error) {
        logger_1.logger.error('Error uploading avatar:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to upload avatar');
    }
};
exports.uploadAvatar = uploadAvatar;
const requestPasswordReset = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            return (0, responses_1.errorResponse)(res, 'Email is required', 400);
        }
        const user = await models_1.User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            logger_1.logger.info(`Password reset requested for non-existent email: ${email}`);
            return (0, responses_1.successResponse)(res, 'If this email exists in our system, a password reset link has been sent');
        }
        logger_1.logger.info(`Password reset requested for user: ${email}`);
        return (0, responses_1.successResponse)(res, 'Password reset instructions have been sent to your email. Please check your inbox and use the Firebase password reset link.');
    }
    catch (error) {
        logger_1.logger.error('Error requesting password reset:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to process password reset request');
    }
};
exports.requestPasswordReset = requestPasswordReset;
//# sourceMappingURL=authController.js.map