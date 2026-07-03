import { Request, Response } from 'express';
import { ProjectInvitation, Project, User, ProjectPermission, AuditLog } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { emailService } from '../services/emailService';
import { createNotification } from './notificationController';
import crypto from 'crypto';
import { decryptField, decryptProjectFields } from '../utils/fieldEncryption';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

// Send project invitation
export const sendInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, email, role, permissions } = req.body;

    if (!projectId || !email || !role) {
      return errorResponse(res, 'Project ID, email, and role are required', 400);
    }

    if (role !== 'member') {
      return errorResponse(res, 'Role must be "member"', 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse(res, 'Invalid email format', 400);
    }

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if this is a personal project
    if (project.isPersonal === true) {
      return errorResponse(res, 'Cannot send invitations to personal projects', 403);
    }

    // Check if user is project owner (only owners can invite)
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // Check if user has global permission to manage all projects
    const user = await User.findById(req.user._id);
    const hasGlobalManagePermission = user?.permissions?.canManageAllProjects === true;

    if (!isOwner && !isInOwners && !hasGlobalManagePermission) {
      return errorResponse(res, 'Only project owners or users with manage all projects permission can send invitations', 403);
    }

    // Check if user is already a member
    const normalizedEmail = email.toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      const isMember = project.members.some((member: any) => {
        const memberId = typeof member === 'object' && member._id
          ? member._id.toString()
          : member.toString();
        return memberId === existingUser._id.toString();
      });

      const isManager = project.managers && project.managers.some((manager: any) => {
        const managerId = typeof manager === 'object' && manager._id
          ? manager._id.toString()
          : manager.toString();
        return managerId === existingUser._id.toString();
      });

      if (isMember || isManager) {
        return errorResponse(res, 'User is already a member of this project', 400);
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await ProjectInvitation.findOne({
      projectId,
      invitedEmail: normalizedEmail,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    });

    if (existingInvitation) {
      return errorResponse(res, 'A pending invitation already exists for this email', 400);
    }

    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');

    // Set expiration date (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Create invitation
    const invitation = new ProjectInvitation({
      projectId,
      invitedEmail: normalizedEmail,
      invitedBy: req.user._id,
      role,
      permissions: permissions || undefined, // Store custom permissions if provided
      token,
      status: 'pending',
      expiresAt
    });

    await invitation.save();

    // Populate fields for email
    await invitation.populate('projectId', 'name description color');
    await invitation.populate('invitedBy', 'displayName email');

    // projectId is a populated reference (not invitation's own field) — safe to decrypt
    // in place, it isn't persisted back when invitation.save() runs elsewhere.
    decryptProjectFields(invitation.projectId as any);

    // Send invitation email — non-blocking: invitation is always saved regardless of email outcome
    try {
      const emailSent = await emailService.sendProjectInvitation(
        normalizedEmail,
        {
          projectName: (invitation.projectId as any).name,
          projectDescription: (invitation.projectId as any).description,
          inviterName: (invitation.invitedBy as any).displayName,
          role: 'Team Member',
          invitationUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/invitations/${token}`,
          expiresAt: invitation.expiresAt
        }
      );

      if (!emailSent) {
        logger.warn(`Email not sent for invitation to ${normalizedEmail} (email service not configured or unavailable)`);
      }
    } catch (emailError) {
      logger.error('Failed to send invitation email (exception):', emailError);
      // Log but do not delete the invitation — it can still be accepted manually
    }

    // Create notification for the invited user if they exist
    if (existingUser) {
      try {
        await createNotification({
          userId: existingUser._id.toString(),
          type: 'project_invitation',
          title: 'New Project Invitation',
          message: `${req.user.displayName} invited you to join "${(invitation.projectId as any).name}"`,
          metadata: {
            projectId: project._id.toString(),
            projectName: (invitation.projectId as any).name,
            invitationId: invitation._id.toString(),
            actionBy: req.user._id,
            actionByName: req.user.displayName,
          },
        });
      } catch (notifError) {
        logger.error('Failed to create notification:', notifError);
      }
    }

    logger.info(`Invitation created for ${normalizedEmail} (project ${projectId}) by ${req.user.email}`);
    return successResponse(res, 'Invitation sent successfully', {
      id: invitation._id,
      email: invitation.invitedEmail,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    logger.error('Error sending invitation:', error);
    return internalServerErrorResponse(res, 'Failed to send invitation');
  }
};

// Get project invitations (for project owners)
export const getProjectInvitations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;

    // Check if project exists and user is owner
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // Check if user has global permission to manage all projects
    const user = await User.findById(req.user._id);
    const hasGlobalManagePermission = user?.permissions?.canManageAllProjects === true;

    if (!isOwner && !isInOwners && !hasGlobalManagePermission) {
      return errorResponse(res, 'Only project owners or users with manage all projects permission can view invitations', 403);
    }

    const invitations = await ProjectInvitation.find({ projectId })
      .populate('invitedBy', 'displayName email')
      .sort({ createdAt: -1 });

    return successResponse(res, 'Invitations retrieved successfully', invitations);
  } catch (error) {
    logger.error('Error getting project invitations:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve invitations');
  }
};

// Get user's pending invitations
export const getUserInvitations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const invitations = await ProjectInvitation.findPendingByEmail(req.user.email);

    // Include token in response for user's own invitations (needed for accept/reject)
    const invitationsWithToken = invitations.map((inv: any) => {
      const token = inv.token; // Get token BEFORE toObject() to avoid toJSON transform
      const invObj = inv.toObject();
      if (invObj.projectId && typeof invObj.projectId === 'object') {
        decryptProjectFields(invObj.projectId);
      }
      invObj.token = token; // Add it back
      invObj.id = invObj._id;
      delete invObj._id;
      delete invObj.__v;
      return invObj;
    });

    return successResponse(res, 'Invitations retrieved successfully', invitationsWithToken);
  } catch (error) {
    logger.error('Error getting user invitations:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve invitations');
  }
};

// Get invitation by token
export const getInvitationByToken = async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    const invitation = await ProjectInvitation.findByToken(token);

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found or expired');
    }

    decryptProjectFields(invitation.projectId as any);

    return successResponse(res, 'Invitation retrieved successfully', {
      id: invitation._id,
      projectId: invitation.projectId,
      projectName: (invitation.projectId as any).name,
      projectDescription: (invitation.projectId as any).description,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      invitedBy: (invitation.invitedBy as any).displayName,
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    logger.error('Error getting invitation by token:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve invitation');
  }
};

// Accept invitation (public) - user clicks accept before signing in
export const acceptInvitation = async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    // First try to find pending invitation by token
    let invitation = await ProjectInvitation.findByToken(token);

    // If not found as pending, check if it's already accepted
    if (!invitation) {
      invitation = await ProjectInvitation.findOne({
        token,
        status: { $in: ['accepted', 'pending'] },
        expiresAt: { $gt: new Date() }
      })
        .populate('projectId', 'name description color')
        .populate('invitedBy', 'displayName email');
    }

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found or expired');
    }

    if (invitation.projectId && typeof invitation.projectId === 'object') {
      decryptProjectFields(invitation.projectId as any);
    }

    // If invitation is already accepted, return success (idempotent operation)
    if (invitation.status === 'accepted') {
      logger.info(`Invitation ${invitation._id} already accepted (token)`);
      return successResponse(res, 'Invitation already accepted', {
        id: invitation._id,
        projectId: invitation.projectId,
        role: invitation.role,
        expiresAt: invitation.expiresAt
      });
    }

    // If client provided an Authorization header, ensure it matches the token
    const authHeader = req.headers.authorization as string | undefined;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        const bearer = parts[1];
        if (bearer !== token) {
          return errorResponse(res, 'Invalid invitation token', 403);
        }
      }
    }

    // Mark invitation as accepted (so the user can sign in and complete it)
    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    await invitation.save();

    logger.info(`Invitation ${invitation._id} accepted (token)`);

    return successResponse(res, 'Invitation accepted successfully', {
      id: invitation._id,
      projectId: invitation.projectId,
      role: invitation.role,
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    logger.error('Error accepting invitation:', error);
    return internalServerErrorResponse(res, 'Failed to accept invitation');
  }
};

// Accept invitation
// Complete invitation after user signs in
export const completeInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.body;

    if (!token) {
      return errorResponse(res, 'Invitation token is required', 400);
    }

    const invitation = await ProjectInvitation.findOne({ 
      token,
      status: 'accepted'
    });

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found or not yet accepted');
    }

    // Check if invitation email matches user email
    if (invitation.invitedEmail !== req.user.email.toLowerCase()) {
      return errorResponse(res, 'This invitation is for a different email address', 403);
    }

    // Get project
    const project = await Project.findById(invitation.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // project is saved again below (adding the new member), so its name is decrypted
    // into a local plaintext var rather than mutated in place — mutating in place here
    // would persist the decrypted plaintext back over the ciphertext on save.
    const projectNamePlain = decryptField(project.name, project._id.toString());

    // Check if user is already a member
    const isMember = project.members.some((member: any) => {
      const memberId = typeof member === 'object' && member._id
        ? member._id.toString()
        : member.toString();
      return memberId === req.user._id;
    });

    if (isMember) {
      invitation.status = 'completed';
      await invitation.save();
      return errorResponse(res, 'You are already a member of this project', 400);
    }

    // Add user to project as member (managers array is managed separately)
    // All invited users are added as regular members

    // Always add to members array
    project.members.push(req.user._id as any);
    await project.save();

    // Create permissions for the user (use custom permissions from invitation or defaults)
    try {
      const existingPermission = await ProjectPermission.findOne({
        projectId: project._id,
        userId: req.user._id
      });

      if (!existingPermission) {
        // Convert old roles to 'member' for backward compatibility
        const role = invitation.role === 'assignee' || invitation.role === 'manager' ? 'member' : invitation.role;
        
        // Use custom permissions from invitation if provided, otherwise use defaults
        const permissions = invitation.permissions
          ? invitation.permissions
          : ProjectPermission.getDefaultPermissions(role as 'owner' | 'member');

        await ProjectPermission.create({
          projectId: project._id,
          userId: req.user._id,
          role: role as 'owner' | 'member',
          permissions
        });
      }
    } catch (permError) {
      logger.error('Failed to create permissions:', permError);
      // Continue even if permission creation fails
    }

    // Log the member addition in audit log
    try {
      await AuditLog.logAction({
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
    } catch (auditError) {
      logger.error('Failed to log audit action:', auditError);
      // Continue even if audit logging fails
    }

    // Update invitation status to completed
    invitation.status = 'completed';
    await invitation.save();

    // Create notification for the new member
    try {
      await createNotification({
        userId: req.user._id,
        type: 'project_added',
        title: 'Added to Project',
        message: `You have been added to the project "${projectNamePlain}"`,
        metadata: {
          projectId: project._id.toString(),
          projectName: projectNamePlain,
        },
      });
    } catch (notifError) {
      logger.error('Failed to create notification for new member:', notifError);
    }

    // Send notification to project owner
    try {
      const owner = await User.findById(project.ownerId);
      if (owner && owner.email) {
        await emailService.sendInvitationAcceptedNotification(
          owner.email,
          {
            projectName: projectNamePlain,
            memberName: req.user.displayName,
            memberEmail: req.user.email,
            role: 'Team Member'
          }
        );
      }
    } catch (emailError) {
      logger.error('Failed to send acceptance notification:', emailError);
    }

    logger.info(`User ${req.user.email} completed invitation to project ${projectNamePlain}`);

    return successResponse(res, 'Successfully joined project', {
      projectId: project._id,
      projectName: projectNamePlain,
      role: invitation.role
    });
  } catch (error) {
    logger.error('Error completing invitation:', error);
    return internalServerErrorResponse(res, 'Failed to complete invitation');
  }
};

// Reject invitation
export const rejectInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.params;

    const invitation = await ProjectInvitation.findByToken(token);

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found or expired');
    }

    // Check if invitation email matches user email
    if (invitation.invitedEmail !== req.user.email.toLowerCase()) {
      return errorResponse(res, 'This invitation is for a different email address', 403);
    }

    // Update invitation status
    invitation.status = 'rejected';
    invitation.rejectedAt = new Date();
    await invitation.save();

    logger.info(`User ${req.user.email} rejected invitation to project ${invitation.projectId}`);

    return successResponse(res, 'Invitation rejected successfully');
  } catch (error) {
    logger.error('Error rejecting invitation:', error);
    return internalServerErrorResponse(res, 'Failed to reject invitation');
  }
};

// Cancel invitation (for project owners)
export const cancelInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { invitationId } = req.params;

    const invitation = await ProjectInvitation.findById(invitationId);

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found');
    }

    // Check if project exists and user is owner
    const project = await Project.findById(invitation.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // Check if user has global permission to manage all projects
    const user = await User.findById(req.user._id);
    const hasGlobalManagePermission = user?.permissions?.canManageAllProjects === true;

    if (!isOwner && !isInOwners && !hasGlobalManagePermission) {
      return errorResponse(res, 'Only project owners or users with manage all projects permission can cancel invitations', 403);
    }

    // Delete the invitation
    await ProjectInvitation.findByIdAndDelete(invitationId);

    logger.info(`Invitation ${invitationId} cancelled by ${req.user.email}`);

    return successResponse(res, 'Invitation cancelled successfully');
  } catch (error) {
    logger.error('Error cancelling invitation:', error);
    return internalServerErrorResponse(res, 'Failed to cancel invitation');
  }
};

// Resend invitation
export const resendInvitation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { invitationId } = req.params;

    const invitation = await ProjectInvitation.findById(invitationId)
      .populate('projectId', 'name description')
      .populate('invitedBy', 'displayName email');

    if (!invitation) {
      return notFoundResponse(res, 'Invitation not found');
    }

    if (invitation.projectId && typeof invitation.projectId === 'object') {
      decryptProjectFields(invitation.projectId as any);
    }

    if (invitation.status !== 'pending') {
      return errorResponse(res, 'Only pending invitations can be resent', 400);
    }

    // Check if project exists and user is owner
    const project = await Project.findById(invitation.projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // Check if user has global permission to manage all projects
    const user = await User.findById(req.user._id);
    const hasGlobalManagePermission = user?.permissions?.canManageAllProjects === true;

    if (!isOwner && !isInOwners && !hasGlobalManagePermission) {
      return errorResponse(res, 'Only project owners or users with manage all projects permission can resend invitations', 403);
    }

    // Extend expiration
    const newExpirationDate = new Date();
    newExpirationDate.setDate(newExpirationDate.getDate() + 7);
    invitation.expiresAt = newExpirationDate;
    await invitation.save();

    // Resend email
    try {
      await emailService.sendProjectInvitation(
        invitation.invitedEmail,
        {
          projectName: (invitation.projectId as any).name,
          projectDescription: (invitation.projectId as any).description,
          inviterName: (invitation.invitedBy as any).displayName,
          role: 'Team Member',
          invitationUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/invitations/${invitation.token}`,
          expiresAt: invitation.expiresAt
        }
      );

      logger.info(`Invitation ${invitationId} resent to ${invitation.invitedEmail}`);
      return successResponse(res, 'Invitation resent successfully', {
        id: invitation._id,
        email: invitation.invitedEmail,
        expiresAt: invitation.expiresAt
      });
    } catch (emailError) {
      logger.error('Failed to resend invitation email:', emailError);
      return internalServerErrorResponse(res, 'Failed to resend invitation email');
    }
  } catch (error) {
    logger.error('Error resending invitation:', error);
    return internalServerErrorResponse(res, 'Failed to resend invitation');
  }
};
