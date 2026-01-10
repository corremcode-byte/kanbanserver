"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyPermission = exports.deleteUserPermission = exports.updateUserPermission = exports.getUserPermission = exports.getProjectPermissions = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const getProjectPermissions = async (req, res) => {
    try {
        const { projectId } = req.params;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        if (!isOwner && !isInOwners) {
            const userPermission = await models_1.ProjectPermission.findOne({
                projectId,
                userId: req.user._id
            });
            if (!userPermission || !userPermission.permissions.canManagePermissions) {
                return (0, responses_1.errorResponse)(res, 'You do not have permission to manage permissions', 403);
            }
        }
        const permissions = await models_1.ProjectPermission.find({ projectId })
            .populate('userId', 'displayName email photoURL role')
            .sort({ createdAt: -1 });
        const validPermissions = permissions.filter(p => p.userId != null);
        const normalizedPermissions = validPermissions.map((p) => {
            const defaults = models_1.ProjectPermission.getDefaultPermissions(p.role);
            return {
                ...p.toJSON(),
                permissions: { ...defaults, ...p.permissions }
            };
        });
        return (0, responses_1.successResponse)(res, 'Permissions retrieved successfully', normalizedPermissions);
    }
    catch (error) {
        logger_1.logger.error('Error getting project permissions:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve permissions');
    }
};
exports.getProjectPermissions = getProjectPermissions;
const getUserPermission = async (req, res) => {
    try {
        const { projectId, userId } = req.params;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const permission = await models_1.ProjectPermission.findOne({ projectId, userId })
            .populate('userId', 'displayName email photoURL role');
        if (!permission) {
            return (0, responses_1.notFoundResponse)(res, 'Permission not found');
        }
        const defaults = models_1.ProjectPermission.getDefaultPermissions(permission.role);
        const normalizedPermission = {
            ...permission.toJSON(),
            permissions: { ...defaults, ...permission.permissions }
        };
        return (0, responses_1.successResponse)(res, 'Permission retrieved successfully', normalizedPermission);
    }
    catch (error) {
        logger_1.logger.error('Error getting user permission:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve permission');
    }
};
exports.getUserPermission = getUserPermission;
const updateUserPermission = async (req, res) => {
    try {
        const { projectId, userId } = req.params;
        const { permissions, role } = req.body;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        if (!isOwner && !isInOwners) {
            const userPermission = await models_1.ProjectPermission.findOne({
                projectId,
                userId: req.user._id
            });
            if (!userPermission || !userPermission.permissions.canManagePermissions) {
                return (0, responses_1.errorResponse)(res, 'You do not have permission to manage permissions', 403);
            }
        }
        if (userId === ownerId) {
            return (0, responses_1.errorResponse)(res, 'Cannot change owner permissions', 400);
        }
        let permission = await models_1.ProjectPermission.findOne({ projectId, userId });
        if (!permission) {
            const defaultPerms = models_1.ProjectPermission.getDefaultPermissions(role || 'assignee');
            const mergedPermissions = permissions ? { ...defaultPerms, ...permissions } : defaultPerms;
            permission = new models_1.ProjectPermission({
                projectId,
                userId,
                role: role || 'assignee',
                permissions: mergedPermissions
            });
        }
        else {
            if (permissions) {
                const targetRole = role || permission.role;
                const defaultPerms = models_1.ProjectPermission.getDefaultPermissions(targetRole);
                const mergedPermissions = { ...defaultPerms, ...permissions };
                Object.keys(mergedPermissions).forEach(key => {
                    permission.permissions[key] = mergedPermissions[key];
                });
                permission.markModified('permissions');
            }
            if (role && role !== permission.role) {
                permission.role = role;
                if (role === 'manager') {
                    if (!project.managers) {
                        project.managers = [];
                    }
                    if (!project.managers.some(m => m.toString() === userId)) {
                        project.managers.push(userId);
                    }
                }
                else {
                    if (project.managers) {
                        project.managers = project.managers.filter(m => m.toString() !== userId);
                    }
                }
                await project.save();
            }
        }
        await permission.save();
        try {
            await models_1.AuditLog.logAction({
                projectId: projectId,
                userId: req.user._id,
                action: 'permission_changed',
                entityType: 'permission',
                entityId: userId,
                metadata: {
                    targetUserId: userId,
                    newRole: role || permission.role,
                    newPermissions: permission.permissions
                }
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        await permission.populate('userId', 'displayName email photoURL role');
        const defaults = models_1.ProjectPermission.getDefaultPermissions(permission.role);
        const normalizedPermission = {
            ...permission.toJSON(),
            permissions: { ...defaults, ...permission.permissions }
        };
        return (0, responses_1.successResponse)(res, 'Permission updated successfully', normalizedPermission);
    }
    catch (error) {
        logger_1.logger.error('Error updating user permission:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update permission');
    }
};
exports.updateUserPermission = updateUserPermission;
const deleteUserPermission = async (req, res) => {
    try {
        const { projectId, userId } = req.params;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        if (!isOwner && !isInOwners) {
            const userPermission = await models_1.ProjectPermission.findOne({
                projectId,
                userId: req.user._id
            });
            if (!userPermission || !userPermission.permissions.canManagePermissions) {
                return (0, responses_1.errorResponse)(res, 'You do not have permission to manage permissions', 403);
            }
        }
        if (userId === ownerId) {
            return (0, responses_1.errorResponse)(res, 'Cannot remove owner from project', 400);
        }
        await models_1.ProjectPermission.findOneAndDelete({ projectId, userId });
        project.members = project.members.filter(m => m.toString() !== userId);
        if (project.managers) {
            project.managers = project.managers.filter(m => m.toString() !== userId);
        }
        await project.save();
        try {
            await models_1.AuditLog.logAction({
                projectId: projectId,
                userId: req.user._id,
                action: 'member_removed',
                entityType: 'member',
                entityId: userId,
                metadata: {
                    removedUserId: userId
                }
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        return (0, responses_1.successResponse)(res, 'Permission deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting user permission:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete permission');
    }
};
exports.deleteUserPermission = deleteUserPermission;
const getMyPermission = async (req, res) => {
    try {
        const { projectId } = req.params;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        if (isOwner) {
            return (0, responses_1.successResponse)(res, 'Permission retrieved successfully', {
                role: 'owner',
                permissions: models_1.ProjectPermission.getDefaultPermissions('owner'),
                isOwner: true
            });
        }
        const permission = await models_1.ProjectPermission.findOne({
            projectId,
            userId: req.user._id
        });
        if (!permission) {
            return (0, responses_1.notFoundResponse)(res, 'Permission not found. You may not be a member of this project.');
        }
        const defaults = models_1.ProjectPermission.getDefaultPermissions(permission.role);
        return (0, responses_1.successResponse)(res, 'Permission retrieved successfully', {
            ...permission.toJSON(),
            permissions: { ...defaults, ...permission.permissions },
            isOwner: false
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting my permission:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve permission');
    }
};
exports.getMyPermission = getMyPermission;
//# sourceMappingURL=permissionsController.js.map