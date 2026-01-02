"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reorderLists = exports.deleteList = exports.updateList = exports.addList = exports.leaveProject = exports.transferOwnership = exports.removeOwner = exports.addOwner = exports.updateMemberRole = exports.removeMember = exports.addMember = exports.deleteProject = exports.updateProject = exports.createProject = exports.getProject = exports.getProjects = void 0;
const models_1 = require("../models");
const AuditLog_1 = require("../models/AuditLog");
const ProjectPermission_1 = require("../models/ProjectPermission");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const mongoose_1 = require("mongoose");
const socket_1 = require("../socket");
const socketHandlers_1 = require("../socket/socketHandlers");
const emailService_1 = require("../services/emailService");
const isProjectManager = (project, userId) => {
    const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
        ? project.ownerId._id.toString()
        : project.ownerId.toString();
    const isOwner = ownerId === userId;
    const isInOwners = !project.owners
        ? isOwner
        : project.owners.some((owner) => {
            const ownerId = typeof owner === 'object' && owner._id
                ? owner._id.toString()
                : owner.toString();
            return ownerId === userId;
        });
    const isInManagers = project.managers && project.managers.some((manager) => {
        const managerId = typeof manager === 'object' && manager._id
            ? manager._id.toString()
            : manager.toString();
        return managerId === userId;
    });
    return isOwner || isInOwners || isInManagers;
};
const getProjects = async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        let query = {
            $or: [
                { ownerId: req.user._id },
                { members: req.user._id },
                { managers: req.user._id }
            ]
        };
        if (status && status !== 'all') {
            query.status = status;
        }
        else {
            query.status = { $ne: 'archived' };
        }
        if (search && typeof search === 'string') {
            query.$and = [{
                    $or: [
                        { name: { $regex: search, $options: 'i' } },
                        { description: { $regex: search, $options: 'i' } }
                    ]
                }];
        }
        const projects = await models_1.Project.find(query)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar')
            .sort({ updatedAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum);
        const total = await models_1.Project.countDocuments(query);
        const projectsWithRole = projects.map(project => {
            const projectObj = project.toObject();
            const userId = req.user._id;
            const ownerId = typeof projectObj.ownerId === 'object' && projectObj.ownerId._id
                ? projectObj.ownerId._id.toString()
                : projectObj.ownerId.toString();
            const isOwner = ownerId === userId;
            const isInOwners = projectObj.owners && projectObj.owners.some((owner) => {
                const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
                return owId === userId;
            });
            const isInManagers = projectObj.managers && projectObj.managers.some((manager) => {
                const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
                return managerId === userId;
            });
            let userRole = 'member';
            if (isOwner || isInOwners) {
                userRole = 'owner';
            }
            else if (isInManagers) {
                userRole = 'manager';
            }
            console.log(`Project "${projectObj.name}" role determination:`, {
                projectId: projectObj._id,
                userId,
                ownerId,
                isOwner,
                isInOwners,
                isInManagers,
                userRole
            });
            return {
                ...projectObj,
                userRole
            };
        });
        console.log(`Returning ${projectsWithRole.length} projects with roles`);
        return (0, responses_1.successResponse)(res, 'Projects retrieved successfully', {
            projects: projectsWithRole,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting projects:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get projects');
    }
};
exports.getProjects = getProjects;
const getProject = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('getProject called with:', { id, user: req.user, headers: req.headers.authorization });
        if (!req.user) {
            console.log('Auth error: No user object found on request');
            return (0, responses_1.errorResponse)(res, 'User not authenticated', 401);
        }
        if (!mongoose_1.Types.ObjectId.isValid(id)) {
            return (0, responses_1.errorResponse)(res, 'Invalid project ID', 400);
        }
        const project = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        console.log('Project found:', project ? {
            id: project._id,
            owner: project.ownerId,
            members: project.members.map(m => m._id)
        } : 'null');
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwnerOrMember = isProjectManager(project, req.user._id) ||
            project.members.some(member => {
                const memberId = typeof member === 'object' && member._id
                    ? member._id.toString()
                    : member.toString();
                return memberId === req.user._id;
            });
        console.log('Project access debug:', {
            projectId: id,
            projectOwner: ownerId,
            projectOwners: project.owners ? project.owners.map((owner) => {
                const ownerId = typeof owner === 'object' && owner._id
                    ? owner._id.toString()
                    : owner.toString();
                return ownerId;
            }) : [],
            userId: req.user._id,
            isOwner: ownerId === req.user._id,
            isInOwners: project.owners && project.owners.some((owner) => {
                const ownerId = typeof owner === 'object' && owner._id
                    ? owner._id.toString()
                    : owner.toString();
                return ownerId === req.user._id;
            }),
            isInManagers: project.managers && project.managers.some((m) => {
                const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
                return managerId === req.user._id;
            }),
            isManager: isProjectManager(project, req.user._id),
            members: project.members.map(m => {
                const memberId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
                return memberId;
            }),
            isMember: project.members.some(member => {
                const memberId = typeof member === 'object' && member._id
                    ? member._id.toString()
                    : member.toString();
                return memberId === req.user._id;
            })
        });
        if (!isOwnerOrMember) {
            console.log('Access denied for user:', req.user._id, 'to project:', id);
            console.log('User is not a member or owner of this project');
            console.log('Project details:', {
                projectOwner: project.ownerId.toString(),
                userId: req.user._id,
                members: project.members.map(m => m.toString()),
                isOwner: (typeof project.ownerId === 'object' && project.ownerId._id ? project.ownerId._id.toString() : project.ownerId.toString()) === req.user._id,
                isMember: project.members.some(member => {
                    const memberId = typeof member === 'object' && member._id
                        ? member._id.toString()
                        : member.toString();
                    return memberId === req.user._id;
                })
            });
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        const [totalTasks, completedTasks] = await Promise.all([
            models_1.Task.countDocuments({ projectId: project._id }),
            models_1.Task.countDocuments({ projectId: project._id, status: 'completed' })
        ]);
        const projectWithStats = {
            ...project.toJSON(),
            stats: {
                totalTasks,
                completedTasks,
                completionPercentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
            }
        };
        return (0, responses_1.successResponse)(res, 'Project retrieved successfully', projectWithStats);
    }
    catch (error) {
        logger_1.logger.error('Error getting project:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to get project');
    }
};
exports.getProject = getProject;
const createProject = async (req, res) => {
    try {
        const user = await models_1.User.findById(req.user._id);
        if (!user || user.role !== 'admin') {
            return (0, responses_1.errorResponse)(res, 'Only admin users can create projects', 403);
        }
        const { name, description, members = [], lists } = req.body;
        if (!name?.trim()) {
            return (0, responses_1.errorResponse)(res, 'Project name is required', 400);
        }
        if (name.trim().length > 100) {
            return (0, responses_1.errorResponse)(res, 'Project name must be less than 100 characters', 400);
        }
        if (description && description.length > 500) {
            return (0, responses_1.errorResponse)(res, 'Description must be less than 500 characters', 400);
        }
        if (members.length > 0) {
            const validMembers = await models_1.User.find({
                _id: { $in: members },
                isActive: true
            });
            if (validMembers.length !== members.length) {
                return (0, responses_1.errorResponse)(res, 'Some selected members are invalid', 400);
            }
        }
        let columns;
        if (lists && Array.isArray(lists) && lists.length > 0) {
            columns = lists.map((list, index) => ({
                id: list.title.toLowerCase().replace(/\s+/g, '-'),
                title: list.title.trim(),
                color: list.color || '#6B7280',
                order: index,
                assignedMembers: list.assignedMembers || []
            }));
        }
        const creatorId = req.user._id;
        const uniqueMembers = Array.from(new Set([creatorId, ...members.filter((id) => id !== creatorId)]));
        const projectData = {
            name: name.trim(),
            description: description?.trim(),
            ownerId: creatorId,
            owners: [creatorId],
            members: uniqueMembers,
            roles: {
                [creatorId]: 'manager'
            }
        };
        if (columns) {
            projectData.columns = columns;
        }
        const project = new models_1.Project(projectData);
        await project.save();
        await project.populate('ownerId', 'name email avatar');
        await project.populate('members', 'name email avatar');
        await project.populate('managers', 'name email avatar');
        const memberPermissions = uniqueMembers
            .filter(memberId => memberId !== creatorId)
            .map(memberId => ({
            projectId: project._id,
            userId: memberId,
            role: 'assignee',
            permissions: ProjectPermission_1.ProjectPermission.getDefaultPermissions('assignee')
        }));
        if (memberPermissions.length > 0) {
            try {
                await ProjectPermission_1.ProjectPermission.insertMany(memberPermissions);
                logger_1.logger.info(`Created ${memberPermissions.length} permission records for project ${project.name}`);
            }
            catch (permError) {
                logger_1.logger.error('Error creating member permissions:', permError);
            }
        }
        logger_1.logger.info(`Project created: ${project.name} by ${req.user.email}`);
        await AuditLog_1.AuditLog.logAction({
            projectId: project._id.toString(),
            userId: req.user._id,
            action: 'project_updated',
            entityType: 'project',
            entityId: project._id.toString(),
            metadata: {
                projectName: project.name,
                description: project.description,
                memberCount: project.members.length,
                actionType: 'created',
            },
        });
        const io = (0, socket_1.getIO)();
        const memberIds = project.members.map((member) => typeof member === 'object' && member._id ? member._id.toString() : member.toString());
        memberIds.forEach((memberId) => {
            if (memberId !== creatorId) {
                (0, socketHandlers_1.broadcastToUser)(io, memberId, 'project:created', {
                    project,
                    createdBy: {
                        id: req.user._id,
                        name: req.user.displayName,
                        email: req.user.email
                    },
                    timestamp: new Date()
                });
            }
        });
        const memberEmails = [];
        project.members.forEach((member) => {
            if (typeof member === 'object' && member.email && member._id.toString() !== creatorId) {
                memberEmails.push(member.email);
            }
        });
        if (memberEmails.length > 0) {
            emailService_1.emailService.sendProjectCreatedNotification(memberEmails, {
                projectName: project.name,
                projectId: project._id.toString(),
                creatorName: req.user.displayName,
                creatorEmail: req.user.email
            }).catch(error => {
                logger_1.logger.error('Failed to send project creation emails:', error);
            });
        }
        return res.status(201).json({
            success: true,
            message: 'Project created successfully',
            data: project
        });
    }
    catch (error) {
        logger_1.logger.error('Error creating project:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to create project');
    }
};
exports.createProject = createProject;
const updateProject = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, members, status } = req.body;
        if (!mongoose_1.Types.ObjectId.isValid(id)) {
            return (0, responses_1.errorResponse)(res, 'Invalid project ID', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can update project', 403);
        }
        if (name !== undefined) {
            if (!name?.trim()) {
                return (0, responses_1.errorResponse)(res, 'Project name cannot be empty', 400);
            }
            if (name.trim().length > 100) {
                return (0, responses_1.errorResponse)(res, 'Project name must be less than 100 characters', 400);
            }
        }
        if (description !== undefined && description && description.length > 500) {
            return (0, responses_1.errorResponse)(res, 'Description must be less than 500 characters', 400);
        }
        if (status && !['active', 'on-hold', 'completed', 'archived'].includes(status)) {
            return (0, responses_1.errorResponse)(res, 'Invalid status', 400);
        }
        let validatedMembers = project.members;
        if (members) {
            const validMembers = await models_1.User.find({
                _id: { $in: members },
                isActive: true
            });
            if (validMembers.length !== members.length) {
                return (0, responses_1.errorResponse)(res, 'Some selected members are invalid', 400);
            }
            validatedMembers = [...members.filter((id) => id !== req.user._id)];
        }
        const updateData = {
            ...(name !== undefined && { name: name.trim() }),
            ...(description !== undefined && { description: description?.trim() }),
            ...(members && { members: validatedMembers }),
            ...(status && { status })
        };
        const updatedProject = await models_1.Project.findByIdAndUpdate(id, updateData, { new: true, runValidators: true }).populate('ownerId', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'project:updated', {
            project: updatedProject,
            updatedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Project updated: ${updatedProject.name} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Project updated successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error updating project:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update project');
    }
};
exports.updateProject = updateProject;
const deleteProject = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose_1.Types.ObjectId.isValid(id)) {
            return (0, responses_1.errorResponse)(res, 'Invalid project ID', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        if (project.ownerId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Only project owner can delete project', 403);
        }
        const projectName = project.name;
        const memberIds = [...project.members.map(m => m.toString()), ...project.managers.map(m => m.toString())];
        await models_1.Project.findByIdAndUpdate(id, { status: 'archived' });
        await AuditLog_1.AuditLog.logAction({
            projectId: id,
            userId: req.user._id,
            action: 'project_updated',
            entityType: 'project',
            entityId: id,
            metadata: {
                projectName: project.name,
                actionType: 'deleted',
                previousStatus: project.status,
                newStatus: 'archived',
            },
        });
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'project:deleted', {
            projectId: id,
            deletedBy: {
                id: req.user._id,
                name: req.user.displayName,
                email: req.user.email
            },
            timestamp: new Date()
        });
        memberIds.forEach((memberId) => {
            if (memberId !== req.user._id) {
                (0, socketHandlers_1.broadcastToUser)(io, memberId, 'project:deleted', {
                    projectId: id,
                    projectName,
                    deletedBy: {
                        id: req.user._id,
                        name: req.user.displayName
                    },
                    timestamp: new Date()
                });
            }
        });
        logger_1.logger.info(`Project archived: ${projectName} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Project archived successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting project:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete project');
    }
};
exports.deleteProject = deleteProject;
const addMember = async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        if (!mongoose_1.Types.ObjectId.isValid(id) || !mongoose_1.Types.ObjectId.isValid(userId)) {
            return (0, responses_1.errorResponse)(res, 'Invalid ID provided', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can add members', 403);
        }
        const user = await models_1.User.findOne({ _id: userId, isActive: true });
        if (!user) {
            return (0, responses_1.errorResponse)(res, 'User not found or inactive', 404);
        }
        const isMember = project.members.some(member => member.toString() === userId);
        if (isMember) {
            return (0, responses_1.errorResponse)(res, 'User is already a member of this project', 400);
        }
        project.members.push(userId);
        await project.save();
        try {
            const existingPermission = await ProjectPermission_1.ProjectPermission.findOne({
                projectId: id,
                userId: userId
            });
            if (!existingPermission) {
                await ProjectPermission_1.ProjectPermission.create({
                    projectId: id,
                    userId: userId,
                    role: 'assignee',
                    permissions: ProjectPermission_1.ProjectPermission.getDefaultPermissions('assignee')
                });
                logger_1.logger.info(`Created permission record for user ${userId} in project ${id}`);
            }
        }
        catch (permError) {
            logger_1.logger.error('Error creating member permission:', permError);
        }
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Member added to project: ${user.email} to ${project.name}`);
        return (0, responses_1.successResponse)(res, 'Member added successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error adding member:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to add member');
    }
};
exports.addMember = addMember;
const removeMember = async (req, res) => {
    try {
        const { id, userId } = req.params;
        if (!mongoose_1.Types.ObjectId.isValid(id) || !mongoose_1.Types.ObjectId.isValid(userId)) {
            return (0, responses_1.errorResponse)(res, 'Invalid ID provided', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManagerRemove = isProjectManager(project, req.user._id);
        if (!isManagerRemove) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can remove members', 403);
        }
        const isOwner = project.ownerId.toString() === req.user._id;
        const targetIsManager = project.managers && project.managers.some((m) => {
            const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
            return managerId === userId;
        });
        const targetIsOwner = project.owners && project.owners.some((o) => {
            const ownerId = typeof o === 'object' && o._id ? o._id.toString() : o.toString();
            return ownerId === userId;
        });
        const targetIsMainOwner = project.ownerId.toString() === userId;
        if (targetIsManager && !isOwner) {
            return (0, responses_1.errorResponse)(res, 'Only project owner can remove a manager', 403);
        }
        if ((targetIsOwner || targetIsMainOwner) && !isOwner) {
            return (0, responses_1.errorResponse)(res, 'Only the project owner can remove other owners', 403);
        }
        const isMember = project.members.some(member => member.toString() === userId);
        const isManager = targetIsManager;
        if (!isMember && !isManager) {
            return (0, responses_1.errorResponse)(res, 'User is not a member or manager of this project', 400);
        }
        project.members = project.members.filter(member => member.toString() !== userId);
        if (project.managers) {
            project.managers = project.managers.filter((manager) => {
                const managerId = typeof manager === 'object' && manager._id
                    ? manager._id.toString()
                    : manager.toString();
                return managerId !== userId;
            });
        }
        if (project.owners) {
            project.owners = project.owners.filter((owner) => {
                const ownerId = typeof owner === 'object' && owner._id
                    ? owner._id.toString()
                    : owner.toString();
                return ownerId !== userId;
            });
        }
        await project.save();
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Member removed from project: ${userId} from ${project.name}`);
        return (0, responses_1.successResponse)(res, 'Member removed successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error removing member:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to remove member');
    }
};
exports.removeMember = removeMember;
const updateMemberRole = async (req, res) => {
    try {
        const { id, userId } = req.params;
        const { role } = req.body;
        if (!['member', 'manager'].includes(role)) {
            return (0, responses_1.errorResponse)(res, 'Invalid role', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isInMembers = project.members.some(member => {
            const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
            return memberId === userId;
        });
        const isInManagers = project.managers.some(manager => {
            const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
            return managerId === userId;
        });
        if (!isInMembers && !isInManagers) {
            return (0, responses_1.errorResponse)(res, 'User is not a member or manager of this project', 400);
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can update roles', 403);
        }
        if (project.ownerId.toString() === userId) {
            return (0, responses_1.errorResponse)(res, 'Cannot change the role of the project owner', 403);
        }
        const isInOwners = project.owners && project.owners.some((owner) => {
            const ownerId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return ownerId === userId;
        });
        if (isInOwners && project.ownerId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Only the original project owner can change roles of additional owners', 403);
        }
        if (role === 'manager') {
            if (isInMembers) {
                project.members = project.members.filter(member => {
                    const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
                    return memberId !== userId;
                });
                project.managers.push(new mongoose_1.Types.ObjectId(userId));
            }
        }
        else if (role === 'member') {
            if (isInManagers) {
                project.managers = project.managers.filter(manager => {
                    const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
                    return managerId !== userId;
                });
                project.members.push(new mongoose_1.Types.ObjectId(userId));
            }
        }
        await project.save();
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Project member role updated: ${userId} -> ${role}`);
        return (0, responses_1.successResponse)(res, 'Member role updated successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error updating member role:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update member role');
    }
};
exports.updateMemberRole = updateMemberRole;
const addOwner = async (req, res) => {
    try {
        const { id, userId } = req.params;
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        if (project.ownerId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Only project owner can add owners', 403);
        }
        const isMember = project.members.some(member => member.toString() === userId);
        if (!isMember) {
            return (0, responses_1.errorResponse)(res, 'User is not a member of this project', 400);
        }
        if (!project.owners)
            project.owners = [];
        const isAlreadyOwner = project.owners.some((owner) => {
            const ownerId = typeof owner === 'object' && owner._id
                ? owner._id.toString()
                : owner.toString();
            return ownerId === userId;
        });
        if (isAlreadyOwner) {
            return (0, responses_1.errorResponse)(res, 'User is already an owner', 400);
        }
        project.owners.push(new mongoose_1.Types.ObjectId(userId));
        const isInManagers = project.managers.some((m) => {
            const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
            return managerId === userId;
        });
        if (!isInManagers) {
            project.managers.push(new mongoose_1.Types.ObjectId(userId));
        }
        project.members = project.members.filter((m) => {
            const memberId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
            return memberId !== userId;
        });
        await project.save();
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Project owner added: ${userId} to project ${id}`);
        return (0, responses_1.successResponse)(res, 'Owner added successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error adding owner:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to add owner');
    }
};
exports.addOwner = addOwner;
const removeOwner = async (req, res) => {
    try {
        const { id, userId } = req.params;
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        if (project.ownerId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Only project owner can remove owners', 403);
        }
        if (project.ownerId.toString() === userId) {
            return (0, responses_1.errorResponse)(res, 'Cannot remove the original project owner', 400);
        }
        if (project.owners) {
            project.owners = project.owners.filter((owner) => {
                const ownerId = typeof owner === 'object' && owner._id
                    ? owner._id.toString()
                    : owner.toString();
                return ownerId !== userId;
            });
        }
        await project.save();
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Project owner removed: ${userId} from project ${id}`);
        return (0, responses_1.successResponse)(res, 'Owner removed successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error removing owner:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to remove owner');
    }
};
exports.removeOwner = removeOwner;
const transferOwnership = async (req, res) => {
    try {
        const { id } = req.params;
        const { newOwnerId } = req.body;
        if (!mongoose_1.Types.ObjectId.isValid(id) || !mongoose_1.Types.ObjectId.isValid(newOwnerId)) {
            return (0, responses_1.errorResponse)(res, 'Invalid ID provided', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        if (project.ownerId.toString() !== req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Only the project owner can transfer ownership', 403);
        }
        if (newOwnerId === req.user._id) {
            return (0, responses_1.errorResponse)(res, 'Cannot transfer ownership to yourself', 400);
        }
        const newOwner = await models_1.User.findById(newOwnerId);
        if (!newOwner) {
            return (0, responses_1.errorResponse)(res, 'New owner user not found', 404);
        }
        const isMemberOrManager = project.members.some(m => m.toString() === newOwnerId) ||
            (project.managers && project.managers.some(m => m.toString() === newOwnerId));
        if (!isMemberOrManager) {
            return (0, responses_1.errorResponse)(res, 'New owner must be a member or manager of the project', 400);
        }
        const oldOwnerId = project.ownerId;
        project.ownerId = new mongoose_1.Types.ObjectId(newOwnerId);
        project.members = project.members.filter(m => m.toString() !== newOwnerId);
        if (project.managers) {
            project.managers = project.managers.filter(m => m.toString() !== newOwnerId);
        }
        if (project.owners) {
            project.owners = project.owners.filter((o) => {
                const ownerId = typeof o === 'object' && o._id ? o._id.toString() : o.toString();
                return ownerId !== newOwnerId;
            });
        }
        if (!project.managers) {
            project.managers = [];
        }
        project.managers.push(oldOwnerId);
        await project.save();
        const updatedProject = await models_1.Project.findById(id)
            .populate('ownerId', 'name email avatar')
            .populate('owners', 'name email avatar')
            .populate('members', 'name email avatar')
            .populate('managers', 'name email avatar');
        logger_1.logger.info(`Project ownership transferred from ${req.user.email} to ${newOwner.email} for project ${project.name}`);
        return (0, responses_1.successResponse)(res, 'Ownership transferred successfully', updatedProject);
    }
    catch (error) {
        logger_1.logger.error('Error transferring ownership:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to transfer ownership');
    }
};
exports.transferOwnership = transferOwnership;
const leaveProject = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user._id;
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isMember = project.members.some(member => member.toString() === userId);
        if (!isMember) {
            return (0, responses_1.errorResponse)(res, 'You are not a member of this project', 400);
        }
        if (project.ownerId.toString() === userId) {
            return (0, responses_1.errorResponse)(res, 'Project owner cannot leave their own project', 400);
        }
        project.members = project.members.filter(member => member.toString() !== userId);
        project.managers = project.managers.filter(manager => manager.toString() !== userId);
        await project.save();
        logger_1.logger.info(`User ${userId} left project ${project.name}`);
        return (0, responses_1.successResponse)(res, 'Successfully left the project');
    }
    catch (error) {
        logger_1.logger.error('Error leaving project:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to leave project');
    }
};
exports.leaveProject = leaveProject;
const addList = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, color } = req.body;
        if (!title?.trim()) {
            return (0, responses_1.errorResponse)(res, 'List title is required', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can add lists', 403);
        }
        const listId = `list-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newOrder = project.columns ? project.columns.length : 0;
        const newList = {
            id: listId,
            title: title.trim(),
            color: color || '#6B7280',
            order: newOrder
        };
        if (!project.columns) {
            project.columns = [];
        }
        project.columns.push(newList);
        await project.save();
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'list:added', {
            projectId: id,
            list: newList,
            addedBy: {
                id: req.user._id,
                name: req.user.displayName
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`List "${title}" added to project ${project.name} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'List added successfully', newList);
    }
    catch (error) {
        logger_1.logger.error('Error adding list:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to add list');
    }
};
exports.addList = addList;
const updateList = async (req, res) => {
    try {
        const { id, listId } = req.params;
        const { title, color, assignedMembers } = req.body;
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can update lists', 403);
        }
        const listIndex = project.columns?.findIndex(col => col.id === listId);
        if (listIndex === undefined || listIndex === -1) {
            return (0, responses_1.notFoundResponse)(res, 'List not found');
        }
        if (title !== undefined) {
            if (!title.trim()) {
                return (0, responses_1.errorResponse)(res, 'List title cannot be empty', 400);
            }
            project.columns[listIndex].title = title.trim();
        }
        if (color !== undefined) {
            project.columns[listIndex].color = color;
        }
        if (assignedMembers !== undefined) {
            project.columns[listIndex].assignedMembers = assignedMembers;
        }
        await project.save();
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'list:updated', {
            projectId: id,
            list: project.columns[listIndex],
            updatedBy: {
                id: req.user._id,
                name: req.user.displayName
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`List "${listId}" updated in project ${project.name} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'List updated successfully', project.columns[listIndex]);
    }
    catch (error) {
        logger_1.logger.error('Error updating list:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to update list');
    }
};
exports.updateList = updateList;
const deleteList = async (req, res) => {
    try {
        const { id, listId } = req.params;
        const { moveTasksToListId } = req.body;
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can delete lists', 403);
        }
        const listIndex = project.columns?.findIndex(col => col.id === listId);
        if (listIndex === undefined || listIndex === -1) {
            return (0, responses_1.notFoundResponse)(res, 'List not found');
        }
        const tasksInList = await models_1.Task.find({ projectId: id, listId: listId });
        if (tasksInList.length > 0) {
            if (!moveTasksToListId) {
                return (0, responses_1.errorResponse)(res, `Cannot delete list with ${tasksInList.length} tasks. Please specify where to move them.`, 400);
            }
            const targetListExists = project.columns?.some(col => col.id === moveTasksToListId);
            if (!targetListExists) {
                return (0, responses_1.errorResponse)(res, 'Target list does not exist', 400);
            }
            await models_1.Task.updateMany({ projectId: id, listId: listId }, { $set: { listId: moveTasksToListId } });
            logger_1.logger.info(`Moved ${tasksInList.length} tasks from list "${listId}" to "${moveTasksToListId}"`);
        }
        project.columns = project.columns?.filter(col => col.id !== listId);
        project.columns?.forEach((col, index) => {
            col.order = index;
        });
        await project.save();
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'list:deleted', {
            projectId: id,
            listId,
            movedTasksCount: tasksInList.length,
            deletedBy: {
                id: req.user._id,
                name: req.user.displayName
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`List "${listId}" deleted from project ${project.name} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'List deleted successfully');
    }
    catch (error) {
        logger_1.logger.error('Error deleting list:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to delete list');
    }
};
exports.deleteList = deleteList;
const reorderLists = async (req, res) => {
    try {
        const { id } = req.params;
        const { lists } = req.body;
        if (!lists || !Array.isArray(lists)) {
            return (0, responses_1.errorResponse)(res, 'Lists array is required', 400);
        }
        const project = await models_1.Project.findById(id);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isManager = isProjectManager(project, req.user._id);
        if (!isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owner or manager can reorder lists', 403);
        }
        lists.forEach((listUpdate) => {
            const listIndex = project.columns?.findIndex(col => col.id === listUpdate.id);
            if (listIndex !== undefined && listIndex !== -1) {
                project.columns[listIndex].order = listUpdate.order;
            }
        });
        project.columns?.sort((a, b) => a.order - b.order);
        await project.save();
        const io = (0, socket_1.getIO)();
        (0, socketHandlers_1.broadcastToProject)(io, id, 'lists:reordered', {
            projectId: id,
            lists: project.columns,
            reorderedBy: {
                id: req.user._id,
                name: req.user.displayName
            },
            timestamp: new Date()
        });
        logger_1.logger.info(`Lists reordered in project ${project.name} by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Lists reordered successfully', project.columns);
    }
    catch (error) {
        logger_1.logger.error('Error reordering lists:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to reorder lists');
    }
};
exports.reorderLists = reorderLists;
//# sourceMappingURL=projectsController.js.map