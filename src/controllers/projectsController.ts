import { Request, Response } from 'express';
import { Project, Task, User } from '../models';
import { AuditLog } from '../models/AuditLog';
import { ProjectPermission } from '../models/ProjectPermission';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { Types } from 'mongoose';
import winston from 'winston';
import { getIO } from '../socket';
import { broadcastToProject, broadcastToUser } from '../socket/socketHandlers';
import { emailService } from '../services/emailService';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    firebaseUid: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
  firebaseUser?: any;
}

// Helper function to check if user is a manager (owner or in managers array)
const isProjectManager = (project: any, userId: string): boolean => {
  const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
    ? project.ownerId._id.toString()
    : project.ownerId.toString();

  const isOwner = ownerId === userId;

  // Check if user is in owners array (for backward compatibility, if no owners array, owner is considered an owner)
  const isInOwners = !project.owners
    ? isOwner // If no owners array, only the original owner is considered an owner
    : project.owners.some((owner: any) => {
        const ownerId = typeof owner === 'object' && owner._id
          ? owner._id.toString()
          : owner.toString();
        return ownerId === userId;
      });

  // Check if user is in managers array
  const isInManagers = project.managers && project.managers.some((manager: any) => {
    const managerId = typeof manager === 'object' && manager._id
      ? manager._id.toString()
      : manager.toString();
    return managerId === userId;
  });

  return isOwner || isInOwners || isInManagers;
};

export const getProjects = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    let query: any = {
      $or: [
        { ownerId: req.user._id },
        { members: req.user._id },
        { managers: req.user._id }
      ]
    };

    if (status && status !== 'all') {
      query.status = status;
    } else {
      // Default to only active projects (exclude archived)
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

    const projects = await Project.find(query)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar')
      .sort({ updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const total = await Project.countDocuments(query);

    // Add userRole to each project
    const projectsWithRole = projects.map(project => {
      const projectObj = project.toObject();
      const userId = req.user._id;

      // Determine user role
      const ownerId = typeof projectObj.ownerId === 'object' && projectObj.ownerId._id
        ? projectObj.ownerId._id.toString()
        : projectObj.ownerId.toString();

      const isOwner = ownerId === userId;

      const isInOwners = projectObj.owners && projectObj.owners.some((owner: any) => {
        const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
        return owId === userId;
      });

      const isInManagers = projectObj.managers && projectObj.managers.some((manager: any) => {
        const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
        return managerId === userId;
      });

      let userRole: 'owner' | 'manager' | 'member' = 'member';
      if (isOwner || isInOwners) {
        userRole = 'owner';
      } else if (isInManagers) {
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

    return successResponse(res, 'Projects retrieved successfully', {
      projects: projectsWithRole,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Error getting projects:', error);
    return internalServerErrorResponse(res, 'Failed to get projects');
  }
};

export const getProject = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    console.log('getProject called with:', { id, user: req.user, headers: req.headers.authorization });

    if (!req.user) {
      console.log('Auth error: No user object found on request');
      return errorResponse(res, 'User not authenticated', 401);
    }

    if (!Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid project ID', 400);
    }

    const project = await Project.findById(id)
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
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is a member or owner
    // Handle populated owner object vs plain ObjectId
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

    // Debug logging for troubleshooting
    console.log('Project access debug:', {
      projectId: id,
      projectOwner: ownerId,
      projectOwners: project.owners ? project.owners.map((owner: any) => {
        const ownerId = typeof owner === 'object' && owner._id
          ? owner._id.toString()
          : owner.toString();
        return ownerId;
      }) : [],
      userId: req.user._id,
      isOwner: ownerId === req.user._id,
      isInOwners: project.owners && project.owners.some((owner: any) => {
        const ownerId = typeof owner === 'object' && owner._id
          ? owner._id.toString()
          : owner.toString();
        return ownerId === req.user._id;
      }),
      isInManagers: project.managers && project.managers.some((m: any) => {
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
      return errorResponse(res, 'Access denied to this project', 403);
    }

    // Get project statistics
    const [totalTasks, completedTasks] = await Promise.all([
      Task.countDocuments({ projectId: project._id }),
      Task.countDocuments({ projectId: project._id, status: 'completed' })
    ]);

    const projectWithStats = {
      ...project.toJSON(),
      stats: {
        totalTasks,
        completedTasks,
        completionPercentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
      }
    };

    return successResponse(res, 'Project retrieved successfully', projectWithStats);
  } catch (error) {
    logger.error('Error getting project:', error);
    return internalServerErrorResponse(res, 'Failed to get project');
  }
};

export const createProject = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Check if user is admin
    const user = await User.findById(req.user._id);
    if (!user || user.role !== 'admin') {
      return errorResponse(res, 'Only admin users can create projects', 403);
    }

    const { name, description, members = [], lists } = req.body;

    if (!name?.trim()) {
      return errorResponse(res, 'Project name is required', 400);
    }

    if (name.trim().length > 100) {
      return errorResponse(res, 'Project name must be less than 100 characters', 400);
    }

    if (description && description.length > 500) {
      return errorResponse(res, 'Description must be less than 500 characters', 400);
    }

    // Validate member IDs
    if (members.length > 0) {
      const validMembers = await User.find({
        _id: { $in: members },
        isActive: true
      });

      if (validMembers.length !== members.length) {
        return errorResponse(res, 'Some selected members are invalid', 400);
      }
    }

    // Process custom lists
    let columns;
    if (lists && Array.isArray(lists) && lists.length > 0) {
      // Validate and create custom lists
      columns = lists.map((list: { title: string; color?: string; assignedMembers?: string[] }, index: number) => ({
        id: list.title.toLowerCase().replace(/\s+/g, '-'),
        title: list.title.trim(),
        color: list.color || '#6B7280',
        order: index,
        assignedMembers: list.assignedMembers || []
      }));
    }
    // If no lists provided, the pre-save hook will create defaults

    // Always add the creator as a member (and owner)
    const creatorId = req.user._id;
    const uniqueMembers = Array.from(new Set([creatorId, ...members.filter((id: string) => id !== creatorId)]));
    const projectData: any = {
      name: name.trim(),
      description: description?.trim(),
      ownerId: creatorId,
      owners: [creatorId], // Add creator as first owner
      members: uniqueMembers,
      roles: {
        [creatorId]: 'manager'
      }
    };

    // Add custom columns if provided
    if (columns) {
      projectData.columns = columns;
    }

    const project = new Project(projectData);

    await project.save();
    await project.populate('ownerId', 'name email avatar');
    await project.populate('members', 'name email avatar');
    await project.populate('managers', 'name email avatar');

    // Create ProjectPermission records for all members (excluding owner)
    const memberPermissions = uniqueMembers
      .filter(memberId => memberId !== creatorId)
      .map(memberId => ({
        projectId: project._id,
        userId: memberId,
        role: 'assignee', // Default role for new members
        permissions: ProjectPermission.getDefaultPermissions('assignee')
      }));

    if (memberPermissions.length > 0) {
      try {
        await ProjectPermission.insertMany(memberPermissions);
        logger.info(`Created ${memberPermissions.length} permission records for project ${project.name}`);
      } catch (permError) {
        logger.error('Error creating member permissions:', permError);
        // Don't fail the project creation if permissions fail
      }
    }

    logger.info(`Project created: ${project.name} by ${req.user.email}`);

    // Log audit event for project creation
    await AuditLog.logAction({
      projectId: project._id.toString(),
      userId: req.user._id,
      action: 'project_updated',
      entityType: 'project',
      entityId: project._id.toString(),
      metadata: {
        projectName: project.name,
        description: project.description,
        memberCount: project.members.length,
        actionType: 'created', // Flag to indicate this is a project creation
      },
    });

    // Broadcast to all members via socket
    const io = getIO();
    const memberIds = project.members.map((member: any) =>
      typeof member === 'object' && member._id ? member._id.toString() : member.toString()
    );

    memberIds.forEach((memberId: string) => {
      if (memberId !== creatorId) {
        broadcastToUser(io, memberId, 'project:created', {
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

    // Send email notifications to members (excluding creator)
    const memberEmails: string[] = [];
    project.members.forEach((member: any) => {
      if (typeof member === 'object' && member.email && member._id.toString() !== creatorId) {
        memberEmails.push(member.email);
      }
    });

    if (memberEmails.length > 0) {
      emailService.sendProjectCreatedNotification(memberEmails, {
        projectName: project.name,
        projectId: project._id.toString(),
        creatorName: req.user.displayName,
        creatorEmail: req.user.email
      }).catch(error => {
        logger.error('Failed to send project creation emails:', error);
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data: project
    });
  } catch (error) {
    logger.error('Error creating project:', error);
    return internalServerErrorResponse(res, 'Failed to create project');
  }
};

export const updateProject = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, members, status } = req.body;

    if (!Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid project ID', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Permission check is handled by middleware (checkPermission('canEditProject'))

    // Validate inputs
    if (name !== undefined) {
      if (!name?.trim()) {
        return errorResponse(res, 'Project name cannot be empty', 400);
      }
      if (name.trim().length > 100) {
        return errorResponse(res, 'Project name must be less than 100 characters', 400);
      }
    }

    if (description !== undefined && description && description.length > 500) {
      return errorResponse(res, 'Description must be less than 500 characters', 400);
    }

    if (status && !['active', 'on-hold', 'completed', 'archived'].includes(status)) {
      return errorResponse(res, 'Invalid status', 400);
    }

    // Validate member IDs if provided
    let validatedMembers = project.members;
    if (members) {
      const validMembers = await User.find({
        _id: { $in: members },
        isActive: true
      });

      if (validMembers.length !== members.length) {
        return errorResponse(res, 'Some selected members are invalid', 400);
      }

      validatedMembers = [...members.filter((id: string) => id !== req.user._id)];
    }

    const updateData: any = {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() }),
      ...(members && { members: validatedMembers }),
      ...(status && { status })
    };

    const updatedProject = await Project.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).populate('ownerId', 'name email avatar')
     .populate('members', 'name email avatar')
     .populate('managers', 'name email avatar');

    // Broadcast project update to project room via socket
    const io = getIO();
    broadcastToProject(io, id, 'project:updated', {
      project: updatedProject,
      updatedBy: {
        id: req.user._id,
        name: req.user.displayName,
        email: req.user.email
      },
      timestamp: new Date()
    });

    logger.info(`Project updated: ${updatedProject!.name} by ${req.user.email}`);
    return successResponse(res, 'Project updated successfully', updatedProject);
  } catch (error) {
    logger.error('Error updating project:', error);
    return internalServerErrorResponse(res, 'Failed to update project');
  }
};

export const deleteProject = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid project ID', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner can delete project
    if (project.ownerId.toString() !== req.user._id) {
      return errorResponse(res, 'Only project owner can delete project', 403);
    }

    const projectName = project.name;
    const memberIds = [...project.members.map(m => m.toString()), ...project.managers.map(m => m.toString())];

    // Archive instead of hard delete
    await Project.findByIdAndUpdate(id, { status: 'archived' });

    // Log audit event for project deletion/archival
    await AuditLog.logAction({
      projectId: id,
      userId: req.user._id,
      action: 'project_updated',
      entityType: 'project',
      entityId: id,
      metadata: {
        projectName: project.name,
        actionType: 'deleted', // Flag to indicate this is a project deletion/archive
        previousStatus: project.status,
        newStatus: 'archived',
      },
    });

    // Broadcast project deletion/archive to project room and all members via socket
    const io = getIO();
    broadcastToProject(io, id, 'project:deleted', {
      projectId: id,
      deletedBy: {
        id: req.user._id,
        name: req.user.displayName,
        email: req.user.email
      },
      timestamp: new Date()
    });

    // Notify all members individually
    memberIds.forEach((memberId: string) => {
      if (memberId !== req.user._id) {
        broadcastToUser(io, memberId, 'project:deleted', {
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

    logger.info(`Project archived: ${projectName} by ${req.user.email}`);
    return successResponse(res, 'Project archived successfully');
  } catch (error) {
    logger.error('Error deleting project:', error);
    return internalServerErrorResponse(res, 'Failed to delete project');
  }
};

export const addMember = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid ID provided', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Permission check is handled by middleware (checkPermission('canManageMembers'))

    // Check if user exists and is active
    const user = await User.findOne({ _id: userId, isActive: true });
    if (!user) {
      return errorResponse(res, 'User not found or inactive', 404);
    }

    // Check if user is already a member
    const isMember = project.members.some(
      member => member.toString() === userId
    );
    
    if (isMember) {
      return errorResponse(res, 'User is already a member of this project', 400);
    }

    // Add member
    project.members.push(userId);
    await project.save();

    // Create ProjectPermission record for the new member
    try {
      const existingPermission = await ProjectPermission.findOne({
        projectId: id,
        userId: userId
      });

      if (!existingPermission) {
        await ProjectPermission.create({
          projectId: id,
          userId: userId,
          role: 'assignee',
          permissions: ProjectPermission.getDefaultPermissions('assignee')
        });
        logger.info(`Created permission record for user ${userId} in project ${id}`);
      }
    } catch (permError) {
      logger.error('Error creating member permission:', permError);
      // Don't fail the member addition if permission creation fails
    }

    // Send email notification to the added member
    try {
      const { emailService } = await import('../services/emailService');
      const emailSent = await emailService.sendMemberAddedNotification(
        user.email,
        {
          projectName: project.name,
          projectDescription: project.description,
          addedByName: req.user.displayName || req.user.email,
          role: 'Team Member (Assignee)',
          projectUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/projects/${id}`
        }
      );

      if (emailSent) {
        logger.info(`Member added notification email sent to ${user.email} for project ${project.name}`);
      } else {
        logger.warn(`Failed to send member added notification to ${user.email}`);
      }
    } catch (emailError) {
      logger.error('Error sending member added notification:', emailError);
      // Don't fail the member addition if email fails
    }

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Member added to project: ${user.email} to ${project.name}`);
    return successResponse(res, 'Member added successfully', updatedProject);
  } catch (error) {
    logger.error('Error adding member:', error);
    return internalServerErrorResponse(res, 'Failed to add member');
  }
};

export const removeMember = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, userId } = req.params;

    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid ID provided', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Permission check is handled by middleware (checkPermission('canManageMembers'))

    // Check if target user is the owner
    const isOwner = project.ownerId.toString() === req.user._id;

    // Check if target user is a manager
    const targetIsManager = project.managers && project.managers.some((m: any) => {
      const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
      return managerId === userId;
    });

    // Check if target user is in owners array (additional owners)
    const targetIsOwner = project.owners && project.owners.some((o: any) => {
      const ownerId = typeof o === 'object' && o._id ? o._id.toString() : o.toString();
      return ownerId === userId;
    });

    // Check if target is the main owner
    const targetIsMainOwner = project.ownerId.toString() === userId;

    // Only owner can remove another manager
    if (targetIsManager && !isOwner) {
      return errorResponse(res, 'Only project owner can remove a manager', 403);
    }

    // Managers cannot remove owners or the main owner
    if ((targetIsOwner || targetIsMainOwner) && !isOwner) {
      return errorResponse(res, 'Only the project owner can remove other owners', 403);
    }

    // Check if user is in members or managers array
    const isMember = project.members.some(
      member => member.toString() === userId
    );
    const isManager = targetIsManager;

    if (!isMember && !isManager) {
      return errorResponse(res, 'User is not a member or manager of this project', 400);
    }

    // Remove from members array
    project.members = project.members.filter(member => member.toString() !== userId);

    // Remove from managers array
    if (project.managers) {
      project.managers = project.managers.filter((manager: any) => {
        const managerId = typeof manager === 'object' && manager._id
          ? manager._id.toString()
          : manager.toString();
        return managerId !== userId;
      });
    }

    // Remove from owners array if they are an owner
    if (project.owners) {
      project.owners = project.owners.filter((owner: any) => {
        const ownerId = typeof owner === 'object' && owner._id
          ? owner._id.toString()
          : owner.toString();
        return ownerId !== userId;
      });
    }

    await project.save();

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Member removed from project: ${userId} from ${project.name}`);
    return successResponse(res, 'Member removed successfully', updatedProject);
  } catch (error) {
    logger.error('Error removing member:', error);
    return internalServerErrorResponse(res, 'Failed to remove member');
  }
};

export const updateMemberRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, userId } = req.params;
    const { role } = req.body;
    
    if (!['member', 'manager'].includes(role)) {
      return errorResponse(res, 'Invalid role', 400);
    }
    
    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user exists in either members or managers array
    const isInMembers = project.members.some(member => {
      const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
      return memberId === userId;
    });

    const isInManagers = project.managers.some(manager => {
      const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
      return managerId === userId;
    });

    if (!isInMembers && !isInManagers) {
      return errorResponse(res, 'User is not a member or manager of this project', 400);
    }

    // Permission check is handled by middleware (checkPermission('canManageMembers'))

    // Prevent changing the original owner's role
    if (project.ownerId.toString() === userId) {
      return errorResponse(res, 'Cannot change the role of the project owner', 403);
    }

    // Check if target user is in the owners array
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const ownerId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return ownerId === userId;
    });

    // Only the original owner can change roles of additional owners
    if (isInOwners && project.ownerId.toString() !== req.user._id) {
      return errorResponse(res, 'Only the original project owner can change roles of additional owners', 403);
    }

    // Switch role between members and managers arrays
    if (role === 'manager') {
      // Remove from members, add to managers
      if (isInMembers) {
        project.members = project.members.filter(member => {
          const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
          return memberId !== userId;
        });
        project.managers.push(new Types.ObjectId(userId));
      }
      // If already in managers, no action needed
    } else if (role === 'member') {
      // Remove from managers, add to members
      if (isInManagers) {
        project.managers = project.managers.filter(manager => {
          const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
          return managerId !== userId;
        });
        project.members.push(new Types.ObjectId(userId));
      }
      // If already in members, no action needed
    }

    await project.save();

    // Return populated project data
    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Project member role updated: ${userId} -> ${role}`);
    return successResponse(res, 'Member role updated successfully', updatedProject);
  } catch (error) {
    logger.error('Error updating member role:', error);
    return internalServerErrorResponse(res, 'Failed to update member role');
  }
};
export const addOwner = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, userId } = req.params;

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner can add another owner
    if (project.ownerId.toString() !== req.user._id) {
      return errorResponse(res, 'Only project owner can add owners', 403);
    }

    // Check if user is a member of the project
    const isMember = project.members.some(member => member.toString() === userId);
    if (!isMember) {
      return errorResponse(res, 'User is not a member of this project', 400);
    }

    // Check if user is already an owner
    if (!project.owners) project.owners = [];
    const isAlreadyOwner = project.owners.some((owner: any) => {
      const ownerId = typeof owner === 'object' && owner._id
        ? owner._id.toString()
        : owner.toString();
      return ownerId === userId;
    });

    if (isAlreadyOwner) {
      return errorResponse(res, 'User is already an owner', 400);
    }

    // Add user to owners array
    project.owners.push(new Types.ObjectId(userId));

    // Also add to managers array if not already there
    const isInManagers = project.managers.some((m: any) => {
      const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
      return managerId === userId;
    });
    if (!isInManagers) {
      project.managers.push(new Types.ObjectId(userId));
    }

    // Remove from members array if present
    project.members = project.members.filter((m: any) => {
      const memberId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
      return memberId !== userId;
    });

    await project.save();

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Project owner added: ${userId} to project ${id}`);
    return successResponse(res, 'Owner added successfully', updatedProject);
  } catch (error) {
    logger.error('Error adding owner:', error);
    return internalServerErrorResponse(res, 'Failed to add owner');
  }
};

export const removeOwner = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, userId } = req.params;

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner can remove another owner
    if (project.ownerId.toString() !== req.user._id) {
      return errorResponse(res, 'Only project owner can remove owners', 403);
    }

    // Cannot remove the original owner
    if (project.ownerId.toString() === userId) {
      return errorResponse(res, 'Cannot remove the original project owner', 400);
    }

    // Remove from owners array
    if (project.owners) {
      project.owners = project.owners.filter((owner: any) => {
        const ownerId = typeof owner === 'object' && owner._id
          ? owner._id.toString()
          : owner.toString();
        return ownerId !== userId;
      });
    }

    await project.save();

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Project owner removed: ${userId} from project ${id}`);
    return successResponse(res, 'Owner removed successfully', updatedProject);
  } catch (error) {
    logger.error('Error removing owner:', error);
    return internalServerErrorResponse(res, 'Failed to remove owner');
  }
};

export const transferOwnership = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { newOwnerId } = req.body;

    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(newOwnerId)) {
      return errorResponse(res, 'Invalid ID provided', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only the current owner can transfer ownership
    if (project.ownerId.toString() !== req.user._id) {
      return errorResponse(res, 'Only the project owner can transfer ownership', 403);
    }

    // Cannot transfer to yourself
    if (newOwnerId === req.user._id) {
      return errorResponse(res, 'Cannot transfer ownership to yourself', 400);
    }

    // Check if new owner exists
    const newOwner = await User.findById(newOwnerId);
    if (!newOwner) {
      return errorResponse(res, 'New owner user not found', 404);
    }

    // Check if new owner is already a member or manager of the project
    const isMemberOrManager = project.members.some(m => m.toString() === newOwnerId) ||
      (project.managers && project.managers.some(m => m.toString() === newOwnerId));

    if (!isMemberOrManager) {
      return errorResponse(res, 'New owner must be a member or manager of the project', 400);
    }

    // Transfer ownership
    const oldOwnerId = project.ownerId;
    project.ownerId = new Types.ObjectId(newOwnerId);

    // Remove new owner from members array if present
    project.members = project.members.filter(m => m.toString() !== newOwnerId);

    // Remove new owner from managers array if present
    if (project.managers) {
      project.managers = project.managers.filter(m => m.toString() !== newOwnerId);
    }

    // Remove new owner from owners array if present
    if (project.owners) {
      project.owners = project.owners.filter((o: any) => {
        const ownerId = typeof o === 'object' && o._id ? o._id.toString() : o.toString();
        return ownerId !== newOwnerId;
      });
    }

    // Add old owner to managers array (so they still have access)
    if (!project.managers) {
      project.managers = [];
    }
    project.managers.push(oldOwnerId);

    await project.save();

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    logger.info(`Project ownership transferred from ${req.user.email} to ${newOwner.email} for project ${project.name}`);
    return successResponse(res, 'Ownership transferred successfully', updatedProject);
  } catch (error) {
    logger.error('Error transferring ownership:', error);
    return internalServerErrorResponse(res, 'Failed to transfer ownership');
  }
};

export const leaveProject = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is a member of the project
    const isMember = project.members.some(member => member.toString() === userId);
    if (!isMember) {
      return errorResponse(res, 'You are not a member of this project', 400);
    }

    // Project owner cannot leave their own project
    if (project.ownerId.toString() === userId) {
      return errorResponse(res, 'Project owner cannot leave their own project', 400);
    }

    // Remove user from members and managers arrays
    project.members = project.members.filter(member => member.toString() !== userId);
    project.managers = project.managers.filter(manager => manager.toString() !== userId);

    await project.save();

    logger.info(`User ${userId} left project ${project.name}`);
    return successResponse(res, 'Successfully left the project');
  } catch (error) {
    logger.error('Error leaving project:', error);
    return internalServerErrorResponse(res, 'Failed to leave project');
  }
};

// ==================== LIST/COLUMN MANAGEMENT ====================

export const addList = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, color } = req.body;

    if (!title?.trim()) {
      return errorResponse(res, 'List title is required', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner or manager can add lists
    const isManager = isProjectManager(project, req.user._id);
    if (!isManager) {
      return errorResponse(res, 'Only project owner or manager can add lists', 403);
    }

    // Generate unique ID for the new list
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

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, id, 'list:added', {
      projectId: id,
      list: newList,
      addedBy: {
        id: req.user._id,
        name: req.user.displayName
      },
      timestamp: new Date()
    });

    logger.info(`List "${title}" added to project ${project.name} by ${req.user.email}`);
    return successResponse(res, 'List added successfully', newList);
  } catch (error) {
    logger.error('Error adding list:', error);
    return internalServerErrorResponse(res, 'Failed to add list');
  }
};

export const updateList = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, listId } = req.params;
    const { title, color, assignedMembers } = req.body;

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner or manager can update lists
    const isManager = isProjectManager(project, req.user._id);
    if (!isManager) {
      return errorResponse(res, 'Only project owner or manager can update lists', 403);
    }

    const listIndex = project.columns?.findIndex(col => col.id === listId);
    if (listIndex === undefined || listIndex === -1) {
      return notFoundResponse(res, 'List not found');
    }

    if (title !== undefined) {
      if (!title.trim()) {
        return errorResponse(res, 'List title cannot be empty', 400);
      }
      project.columns![listIndex].title = title.trim();
    }

    if (color !== undefined) {
      project.columns![listIndex].color = color;
    }

    if (assignedMembers !== undefined) {
      project.columns![listIndex].assignedMembers = assignedMembers;
    }

    await project.save();

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, id, 'list:updated', {
      projectId: id,
      list: project.columns![listIndex],
      updatedBy: {
        id: req.user._id,
        name: req.user.displayName
      },
      timestamp: new Date()
    });

    logger.info(`List "${listId}" updated in project ${project.name} by ${req.user.email}`);
    return successResponse(res, 'List updated successfully', project.columns![listIndex]);
  } catch (error) {
    logger.error('Error updating list:', error);
    return internalServerErrorResponse(res, 'Failed to update list');
  }
};

export const deleteList = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, listId } = req.params;
    const { moveTasksToListId } = req.body;

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner or manager can delete lists
    const isManager = isProjectManager(project, req.user._id);
    if (!isManager) {
      return errorResponse(res, 'Only project owner or manager can delete lists', 403);
    }

    const listIndex = project.columns?.findIndex(col => col.id === listId);
    if (listIndex === undefined || listIndex === -1) {
      return notFoundResponse(res, 'List not found');
    }

    // Check if there are tasks in this list
    const tasksInList = await Task.find({ projectId: id, listId: listId });

    if (tasksInList.length > 0) {
      if (!moveTasksToListId) {
        return errorResponse(res, `Cannot delete list with ${tasksInList.length} tasks. Please specify where to move them.`, 400);
      }

      // Verify the target list exists
      const targetListExists = project.columns?.some(col => col.id === moveTasksToListId);
      if (!targetListExists) {
        return errorResponse(res, 'Target list does not exist', 400);
      }

      // Move all tasks to the target list
      await Task.updateMany(
        { projectId: id, listId: listId },
        { $set: { listId: moveTasksToListId } }
      );

      logger.info(`Moved ${tasksInList.length} tasks from list "${listId}" to "${moveTasksToListId}"`);
    }

    // Remove the list from the project
    project.columns = project.columns?.filter(col => col.id !== listId);

    // Reorder remaining lists
    project.columns?.forEach((col, index) => {
      col.order = index;
    });

    await project.save();

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, id, 'list:deleted', {
      projectId: id,
      listId,
      movedTasksCount: tasksInList.length,
      deletedBy: {
        id: req.user._id,
        name: req.user.displayName
      },
      timestamp: new Date()
    });

    logger.info(`List "${listId}" deleted from project ${project.name} by ${req.user.email}`);
    return successResponse(res, 'List deleted successfully');
  } catch (error) {
    logger.error('Error deleting list:', error);
    return internalServerErrorResponse(res, 'Failed to delete list');
  }
};

export const reorderLists = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { lists } = req.body;

    if (!lists || !Array.isArray(lists)) {
      return errorResponse(res, 'Lists array is required', 400);
    }

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Only owner or manager can reorder lists
    const isManager = isProjectManager(project, req.user._id);
    if (!isManager) {
      return errorResponse(res, 'Only project owner or manager can reorder lists', 403);
    }

    // Update the order of each list
    lists.forEach((listUpdate: { id: string; order: number }) => {
      const listIndex = project.columns?.findIndex(col => col.id === listUpdate.id);
      if (listIndex !== undefined && listIndex !== -1) {
        project.columns![listIndex].order = listUpdate.order;
      }
    });

    // Sort columns by order
    project.columns?.sort((a, b) => a.order - b.order);

    await project.save();

    // Broadcast to project room via socket
    const io = getIO();
    broadcastToProject(io, id, 'lists:reordered', {
      projectId: id,
      lists: project.columns,
      reorderedBy: {
        id: req.user._id,
        name: req.user.displayName
      },
      timestamp: new Date()
    });

    logger.info(`Lists reordered in project ${project.name} by ${req.user.email}`);
    return successResponse(res, 'Lists reordered successfully', project.columns);
  } catch (error) {
    logger.error('Error reordering lists:', error);
    return internalServerErrorResponse(res, 'Failed to reorder lists');
  }
};