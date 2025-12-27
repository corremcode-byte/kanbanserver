"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendInvitation = exports.cancelInvitation = exports.rejectInvitation = exports.completeInvitation = exports.acceptInvitation = exports.getInvitationByToken = exports.getUserInvitations = exports.getProjectInvitations = exports.sendInvitation = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const emailService_1 = require("../services/emailService");
const crypto_1 = __importDefault(require("crypto"));
const sendInvitation = async (req, res) => {
    try {
        const { projectId, email, role, permissions } = req.body;
        if (!projectId || !email || !role) {
            return (0, responses_1.errorResponse)(res, 'Project ID, email, and role are required', 400);
        }
        if (!['assignee', 'manager'].includes(role)) {
            return (0, responses_1.errorResponse)(res, 'Role must be either "assignee" or "manager"', 400);
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return (0, responses_1.errorResponse)(res, 'Invalid email format', 400);
        }
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
            return (0, responses_1.errorResponse)(res, 'Only project owners can send invitations', 403);
        }
        const normalizedEmail = email.toLowerCase();
        const existingUser = await models_1.User.findOne({ email: normalizedEmail });
        if (existingUser) {
            const isMember = project.members.some((member) => {
                const memberId = typeof member === 'object' && member._id
                    ? member._id.toString()
                    : member.toString();
                return memberId === existingUser._id.toString();
            });
            const isManager = project.managers && project.managers.some((manager) => {
                const managerId = typeof manager === 'object' && manager._id
                    ? manager._id.toString()
                    : manager.toString();
                return managerId === existingUser._id.toString();
            });
            if (isMember || isManager) {
                return (0, responses_1.errorResponse)(res, 'User is already a member of this project', 400);
            }
        }
        const existingInvitation = await models_1.ProjectInvitation.findOne({
            projectId,
            invitedEmail: normalizedEmail,
            status: 'pending',
            expiresAt: { $gt: new Date() }
        });
        if (existingInvitation) {
            return (0, responses_1.errorResponse)(res, 'A pending invitation already exists for this email', 400);
        }
        const token = crypto_1.default.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        const invitation = new models_1.ProjectInvitation({
            projectId,
            invitedEmail: normalizedEmail,
            invitedBy: req.user._id,
            role,
            permissions: permissions || undefined,
            token,
            status: 'pending',
            expiresAt
        });
        await invitation.save();
        await invitation.populate('projectId', 'name description color');
        await invitation.populate('invitedBy', 'displayName email');
        try {
            const emailSent = await emailService_1.emailService.sendProjectInvitation(normalizedEmail, {
                projectName: invitation.projectId.name,
                projectDescription: invitation.projectId.description,
                inviterName: invitation.invitedBy.displayName,
                role: role === 'assignee' ? 'Team Member (Assignee)' : 'Manager',
                invitationUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/invitations/${token}`,
                expiresAt: invitation.expiresAt
            });
            if (!emailSent) {
                logger_1.logger.error(`Email service reported failure sending invitation to ${normalizedEmail}`);
                await models_1.ProjectInvitation.findByIdAndDelete(invitation._id);
                return (0, responses_1.internalServerErrorResponse)(res, 'Failed to send invitation email');
            }
            logger_1.logger.info(`Invitation sent to ${normalizedEmail} for project ${projectId} by ${req.user.email}`);
            return (0, responses_1.successResponse)(res, 'Invitation sent successfully', {
                id: invitation._id,
                email: invitation.invitedEmail,
                role: invitation.role,
                status: invitation.status,
                expiresAt: invitation.expiresAt
            });
        }
        catch (emailError) {
            logger_1.logger.error('Failed to send invitation email (exception):', emailError);
            try {
                await models_1.ProjectInvitation.findByIdAndDelete(invitation._id);
            }
            catch (delErr) {
                logger_1.logger.error('Failed to delete invitation after email error:', delErr);
            }
            return (0, responses_1.internalServerErrorResponse)(res, 'Failed to send invitation email');
        }
    }
    catch (error) {
        logger_1.logger.error('Error sending invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to send invitation');
    }
};
exports.sendInvitation = sendInvitation;
const getProjectInvitations = async (req, res) => {
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
            return (0, responses_1.errorResponse)(res, 'Only project owners can view invitations', 403);
        }
        const invitations = await models_1.ProjectInvitation.find({ projectId })
            .populate('invitedBy', 'displayName email')
            .sort({ createdAt: -1 });
        return (0, responses_1.successResponse)(res, 'Invitations retrieved successfully', invitations);
    }
    catch (error) {
        logger_1.logger.error('Error getting project invitations:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve invitations');
    }
};
exports.getProjectInvitations = getProjectInvitations;
const getUserInvitations = async (req, res) => {
    try {
        const invitations = await models_1.ProjectInvitation.findPendingByEmail(req.user.email);
        return (0, responses_1.successResponse)(res, 'Invitations retrieved successfully', invitations);
    }
    catch (error) {
        logger_1.logger.error('Error getting user invitations:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve invitations');
    }
};
exports.getUserInvitations = getUserInvitations;
const getInvitationByToken = async (req, res) => {
    try {
        const { token } = req.params;
        const invitation = await models_1.ProjectInvitation.findByToken(token);
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found or expired');
        }
        return (0, responses_1.successResponse)(res, 'Invitation retrieved successfully', {
            id: invitation._id,
            projectId: invitation.projectId,
            projectName: invitation.projectId.name,
            projectDescription: invitation.projectId.description,
            invitedEmail: invitation.invitedEmail,
            role: invitation.role,
            invitedBy: invitation.invitedBy.displayName,
            expiresAt: invitation.expiresAt
        });
    }
    catch (error) {
        logger_1.logger.error('Error getting invitation by token:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve invitation');
    }
};
exports.getInvitationByToken = getInvitationByToken;
const acceptInvitation = async (req, res) => {
    try {
        const { token } = req.params;
        const invitation = await models_1.ProjectInvitation.findByToken(token);
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found or expired');
        }
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const parts = authHeader.split(' ');
            if (parts.length === 2 && parts[0] === 'Bearer') {
                const bearer = parts[1];
                if (bearer !== token) {
                    return (0, responses_1.errorResponse)(res, 'Invalid invitation token', 403);
                }
            }
        }
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        await invitation.save();
        logger_1.logger.info(`Invitation ${invitation._id} accepted (token)`);
        return (0, responses_1.successResponse)(res, 'Invitation accepted successfully', {
            id: invitation._id,
            projectId: invitation.projectId,
            role: invitation.role,
            expiresAt: invitation.expiresAt
        });
    }
    catch (error) {
        logger_1.logger.error('Error accepting invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to accept invitation');
    }
};
exports.acceptInvitation = acceptInvitation;
const completeInvitation = async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return (0, responses_1.errorResponse)(res, 'Invitation token is required', 400);
        }
        const invitation = await models_1.ProjectInvitation.findOne({
            token,
            status: 'accepted'
        });
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found or not yet accepted');
        }
        if (invitation.invitedEmail !== req.user.email.toLowerCase()) {
            return (0, responses_1.errorResponse)(res, 'This invitation is for a different email address', 403);
        }
        const project = await models_1.Project.findById(invitation.projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const isMember = project.members.some((member) => {
            const memberId = typeof member === 'object' && member._id
                ? member._id.toString()
                : member.toString();
            return memberId === req.user._id;
        });
        if (isMember) {
            invitation.status = 'completed';
            await invitation.save();
            return (0, responses_1.errorResponse)(res, 'You are already a member of this project', 400);
        }
        if (invitation.role === 'manager') {
            if (!project.managers) {
                project.managers = [];
            }
            project.managers.push(req.user._id);
        }
        project.members.push(req.user._id);
        await project.save();
        try {
            const existingPermission = await models_1.ProjectPermission.findOne({
                projectId: project._id,
                userId: req.user._id
            });
            if (!existingPermission) {
                const permissions = invitation.permissions
                    ? invitation.permissions
                    : models_1.ProjectPermission.getDefaultPermissions(invitation.role);
                await models_1.ProjectPermission.create({
                    projectId: project._id,
                    userId: req.user._id,
                    role: invitation.role,
                    permissions
                });
            }
        }
        catch (permError) {
            logger_1.logger.error('Failed to create permissions:', permError);
        }
        try {
            await models_1.AuditLog.logAction({
                projectId: project._id.toString(),
                userId: req.user._id,
                action: 'member_added',
                entityType: 'member',
                entityId: req.user._id,
                metadata: {
                    role: invitation.role,
                    invitedBy: invitation.invitedBy.toString()
                }
            });
        }
        catch (auditError) {
            logger_1.logger.error('Failed to log audit action:', auditError);
        }
        invitation.status = 'completed';
        await invitation.save();
        try {
            const owner = await models_1.User.findById(project.ownerId);
            if (owner && owner.email) {
                await emailService_1.emailService.sendInvitationAcceptedNotification(owner.email, {
                    projectName: project.name,
                    memberName: req.user.displayName,
                    memberEmail: req.user.email,
                    role: invitation.role === 'assignee' ? 'Team Member (Assignee)' : 'Manager'
                });
            }
        }
        catch (emailError) {
            logger_1.logger.error('Failed to send acceptance notification:', emailError);
        }
        logger_1.logger.info(`User ${req.user.email} completed invitation to project ${project.name}`);
        return (0, responses_1.successResponse)(res, 'Successfully joined project', {
            projectId: project._id,
            projectName: project.name,
            role: invitation.role
        });
    }
    catch (error) {
        logger_1.logger.error('Error completing invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to complete invitation');
    }
};
exports.completeInvitation = completeInvitation;
const rejectInvitation = async (req, res) => {
    try {
        const { token } = req.params;
        const invitation = await models_1.ProjectInvitation.findByToken(token);
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found or expired');
        }
        if (invitation.invitedEmail !== req.user.email.toLowerCase()) {
            return (0, responses_1.errorResponse)(res, 'This invitation is for a different email address', 403);
        }
        invitation.status = 'rejected';
        invitation.rejectedAt = new Date();
        await invitation.save();
        logger_1.logger.info(`User ${req.user.email} rejected invitation to project ${invitation.projectId}`);
        return (0, responses_1.successResponse)(res, 'Invitation rejected successfully');
    }
    catch (error) {
        logger_1.logger.error('Error rejecting invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to reject invitation');
    }
};
exports.rejectInvitation = rejectInvitation;
const cancelInvitation = async (req, res) => {
    try {
        const { invitationId } = req.params;
        const invitation = await models_1.ProjectInvitation.findById(invitationId);
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found');
        }
        const project = await models_1.Project.findById(invitation.projectId);
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
            return (0, responses_1.errorResponse)(res, 'Only project owners can cancel invitations', 403);
        }
        await models_1.ProjectInvitation.findByIdAndDelete(invitationId);
        logger_1.logger.info(`Invitation ${invitationId} cancelled by ${req.user.email}`);
        return (0, responses_1.successResponse)(res, 'Invitation cancelled successfully');
    }
    catch (error) {
        logger_1.logger.error('Error cancelling invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to cancel invitation');
    }
};
exports.cancelInvitation = cancelInvitation;
const resendInvitation = async (req, res) => {
    try {
        const { invitationId } = req.params;
        const invitation = await models_1.ProjectInvitation.findById(invitationId)
            .populate('projectId', 'name description')
            .populate('invitedBy', 'displayName email');
        if (!invitation) {
            return (0, responses_1.notFoundResponse)(res, 'Invitation not found');
        }
        if (invitation.status !== 'pending') {
            return (0, responses_1.errorResponse)(res, 'Only pending invitations can be resent', 400);
        }
        const project = await models_1.Project.findById(invitation.projectId);
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
            return (0, responses_1.errorResponse)(res, 'Only project owners can resend invitations', 403);
        }
        const newExpirationDate = new Date();
        newExpirationDate.setDate(newExpirationDate.getDate() + 7);
        invitation.expiresAt = newExpirationDate;
        await invitation.save();
        try {
            await emailService_1.emailService.sendProjectInvitation(invitation.invitedEmail, {
                projectName: invitation.projectId.name,
                projectDescription: invitation.projectId.description,
                inviterName: invitation.invitedBy.displayName,
                role: invitation.role === 'assignee' ? 'Team Member (Assignee)' : 'Manager',
                invitationUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/invitations/${invitation.token}`,
                expiresAt: invitation.expiresAt
            });
            logger_1.logger.info(`Invitation ${invitationId} resent to ${invitation.invitedEmail}`);
            return (0, responses_1.successResponse)(res, 'Invitation resent successfully', {
                id: invitation._id,
                email: invitation.invitedEmail,
                expiresAt: invitation.expiresAt
            });
        }
        catch (emailError) {
            logger_1.logger.error('Failed to resend invitation email:', emailError);
            return (0, responses_1.internalServerErrorResponse)(res, 'Failed to resend invitation email');
        }
    }
    catch (error) {
        logger_1.logger.error('Error resending invitation:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to resend invitation');
    }
};
exports.resendInvitation = resendInvitation;
//# sourceMappingURL=invitationsController.js.map