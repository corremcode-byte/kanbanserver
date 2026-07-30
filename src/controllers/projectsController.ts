import { Request, Response } from 'express';
import { Project, Task, User } from '../models';
import { AuditLog } from '../models/AuditLog';
import { ProjectPermission } from '../models/ProjectPermission';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { Types } from 'mongoose';
import { getIO } from '../socket';
import { broadcastToProject, broadcastToUser } from '../socket/socketHandlers';
import { emailService } from '../services/emailService';
import { encryptField, decryptField, decryptProjectFields } from '../utils/fieldEncryption';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
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

const getCoOwnerPermission = (project: any, userId: string): 'view' | 'edit' => {
  const coOwnerPermissions = project?.coOwnerPermissions as Map<string, 'view' | 'edit'> | Record<string, 'view' | 'edit'> | undefined;

  if (!coOwnerPermissions) return 'edit';

  if (typeof (coOwnerPermissions as Map<string, 'view' | 'edit'>).get === 'function') {
    return (coOwnerPermissions as Map<string, 'view' | 'edit'>).get(userId) || 'edit';
  }

  return (coOwnerPermissions as Record<string, 'view' | 'edit'>)[userId] || 'edit';
};

export const getProjects = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    let query: any = {
      $or: [
        { ownerId: req.user._id },
        { owners: req.user._id },
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

    // name/description are encrypted at rest, so search can't be done via DB-level
    // $regex — fetch all in-scope candidates, decrypt, then filter/sort/paginate in
    // app code. Same endpoint contract (pagination shape) as before, just computed
    // in Node instead of in MongoDB (mirrors the same migration already done for
    // Task search in searchController.ts).
    const searchStr = typeof search === 'string' ? search.trim() : '';

    const allMatching = await Project.find(query)
      .populate('ownerId', 'name email avatar displayName photoURL')
      .populate('owners', 'name email avatar displayName photoURL')
      .populate('members', 'name email avatar displayName photoURL')
      .populate('managers', 'name email avatar displayName photoURL')
      .sort({ createdAt: -1 });

    // Add userRole to each project (and decrypt name/description)
    let projectsWithRole = allMatching.map(project => {
      const projectObj = project.toObject();
      decryptProjectFields(projectObj);
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
      let coOwnerPerm: 'view' | 'edit' = 'edit';
      if (projectObj.coOwnerPermissions) {
        const coPerms: any = projectObj.coOwnerPermissions;
        if (typeof coPerms.get === 'function') {
          coOwnerPerm = coPerms.get(userId) || 'edit';
        } else {
          coOwnerPerm = coPerms[userId] || 'edit';
        }
      }

      const isInManagers = projectObj.managers && projectObj.managers.some((manager: any) => {
        const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
        return managerId === userId;
      });

      let userRole: 'owner' | 'manager' | 'member' = 'member';
      if (isOwner) {
        userRole = 'owner';
      } else if (isInOwners) {
        userRole = coOwnerPerm === 'edit' ? 'co-owner' as any : 'co-owner-view' as any;
      } else if (isInManagers) {
        userRole = 'manager';
      }      return {
        ...projectObj,
        userRole
      };
    });

    if (searchStr) {
      const queryRegex = new RegExp(searchStr, 'i');
      projectsWithRole = projectsWithRole.filter((p: any) =>
        queryRegex.test(p.name) || (p.description && queryRegex.test(p.description))
      );
    }

    const total = projectsWithRole.length;
    const paginatedProjects = projectsWithRole.slice((pageNum - 1) * limitNum, (pageNum - 1) * limitNum + limitNum);

    return successResponse(res, 'Projects retrieved successfully', {
      projects: paginatedProjects,
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


    if (!req.user) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    if (!Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid project ID', 400);
    }

    const project = await Project.findById(id)
      .populate('ownerId', 'name email avatar displayName photoURL')
      .populate('owners', 'name email avatar displayName photoURL')
      .populate('members', 'name email avatar displayName photoURL')
      .populate('managers', 'name email avatar displayName photoURL');
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    decryptProjectFields(project as any);

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
    if (!isOwnerOrMember) {
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
    // Permission check is handled by middleware (checkCanCreateProject)
    // No need to check again here

    const { name, description, color, members = [], lists, isPersonal = false } = req.body;

    if (!name?.trim()) {
      return errorResponse(res, 'Project name is required', 400);
    }

    if (name.trim().length > 100) {
      return errorResponse(res, 'Project name must be less than 100 characters', 400);
    }

    if (description && description.length > 500) {
      return errorResponse(res, 'Description must be less than 500 characters', 400);
    }

    // Check if user is trying to create personal project
    // Note: Permission check is already done by middleware, but we validate business rules here
    if (isPersonal) {
      // Personal projects cannot have members added
      if (members.length > 0) {
        return errorResponse(res, 'Personal projects cannot have members added', 400);
      }
    }

    // Validate member IDs (only for non-personal projects)
    if (!isPersonal && members.length > 0) {
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
    const uniqueMembers = isPersonal ? [creatorId] : Array.from(new Set([creatorId, ...members.filter((id: string) => id !== creatorId)]));
    const projectData: any = {
      name: name.trim(),
      description: description?.trim(),
      color: color || '#3B82F6',
      isPersonal: isPersonal,
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

    const projectId = project._id.toString();
    project.name = encryptField(name.trim(), projectId) as string;
    project.description = encryptField(description?.trim(), projectId);

    await project.save();
    await project.populate('ownerId', 'name email avatar');
    await project.populate('members', 'name email avatar');
    await project.populate('managers', 'name email avatar');

    decryptProjectFields(project as any);

    // Create ProjectPermission records for all members (excluding owner)
    const memberPermissions = uniqueMembers
      .filter(memberId => memberId !== creatorId)
      .map(memberId => ({
        projectId: project._id,
        userId: memberId,
        role: 'member', // Default role for new members
        permissions: ProjectPermission.getDefaultPermissions('member')
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

    // Send in-app notifications to all initial members (excluding creator)
    try {
      const { createNotification } = await import('./notificationController');
      const notifPromises = memberIds
        .filter((memberId: string) => memberId !== creatorId)
        .map((memberId: string) =>
          createNotification({
            userId: memberId,
            type: 'project_added',
            title: 'Added to Project',
            message: `${req.user.displayName} added you to the project "${project.name}"`,
            metadata: {
              projectId: project._id.toString(),
              projectName: project.name,
              actionBy: req.user._id,
              actionByName: req.user.displayName,
            },
          }).catch((err: unknown) => logger.error(`Failed to create notification for member ${memberId}:`, err))
        );
      await Promise.all(notifPromises);
    } catch (notifError) {
      logger.error('Error sending project creation notifications:', notifError);
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
      ...(name !== undefined && { name: encryptField(name.trim(), id) }),
      ...(description !== undefined && { description: encryptField(description?.trim(), id) }),
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

    if (updatedProject) decryptProjectFields(updatedProject as any);

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

    // Permission check is handled by middleware (checkCanDeleteProject)
    // Middleware allows: owners, users in owners array, and users with global canDeleteProjects permission

    decryptProjectFields(project as any);
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

    // project is saved again below (adding the new member), so its name/description
    // are decrypted into local plaintext vars rather than mutated in place — mutating
    // in place here would persist the decrypted plaintext back over the ciphertext.
    const projectNamePlain = decryptField(project.name, project._id.toString());
    const projectDescriptionPlain = decryptField(project.description, project._id.toString());

    // Check if this is a personal project
    if (project.isPersonal === true) {
      return errorResponse(res, 'Cannot add members to personal projects', 403);
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
          role: 'member',
          permissions: ProjectPermission.getDefaultPermissions('member')
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
          projectName: projectNamePlain,
          projectDescription: projectDescriptionPlain,
          addedByName: req.user.displayName || req.user.email,
          role: 'Team Member (Assignee)',
          projectUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/projects/${id}`
        }
      );

      if (emailSent) {
        logger.info(`Member added notification email sent to ${user.email} for project ${projectNamePlain}`);
      } else {
        logger.warn(`Failed to send member added notification to ${user.email}`);
      }
    } catch (emailError) {
      logger.error('Error sending member added notification:', emailError);
      // Don't fail the member addition if email fails
    }

    // Create in-app notification for the added member
    try {
      const { createNotification } = await import('./notificationController');
      await createNotification({
        userId: userId.toString(),
        type: 'project_added',
        title: 'Added to Project',
        message: `${req.user.displayName} added you to "${projectNamePlain}"`,
        metadata: {
          projectId: id.toString(),
          projectName: projectNamePlain,
          actionBy: req.user._id,
          actionByName: req.user.displayName,
        },
      });
      logger.info(`In-app notification created for user ${userId} added to project ${projectNamePlain}`);
    } catch (notificationError) {
      logger.error('Error creating in-app notification:', notificationError);
      // Don't fail the member addition if notification fails
    }

    const updatedProject = await Project.findById(id)
      .populate('ownerId', 'name email avatar')
      .populate('owners', 'name email avatar')
      .populate('members', 'name email avatar')
      .populate('managers', 'name email avatar');

    if (updatedProject) decryptProjectFields(updatedProject as any);

    logger.info(`Member added to project: ${user.email} to ${projectNamePlain}`);
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

    if (updatedProject) decryptProjectFields(updatedProject as any);

    logger.info(`Member removed from project: ${userId} from ${decryptField(project.name, project._id.toString())}`);
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
    
    if (role !== 'member') {
      return errorResponse(res, 'Invalid role. Only "member" is allowed', 400);
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
      return errorResponse(res, 'User is not a member of this project', 400);
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

    // Ensure user is in members array (move from managers if needed)
    if (isInManagers) {
      // Remove from managers, add to members
      project.managers = project.managers.filter(manager => {
        const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
        return managerId !== userId;
      });
      if (!isInMembers) {
        project.members.push(new Types.ObjectId(userId));
      }
    }
    // If already in members, no action needed

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
    const { permission = 'edit' } = req.body as { permission?: 'view' | 'edit' };

    const project = await Project.findById(id);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    const mainOwnerId = project.ownerId.toString();
    const isMainOwner = mainOwnerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });
    const requesterCoOwnerPermission = isInOwners ? getCoOwnerPermission(project, req.user._id) : 'edit';

    // Main owner can always add co-owner. Co-owner needs edit permission.
    if (!isMainOwner && (!isInOwners || requesterCoOwnerPermission !== 'edit')) {
      return errorResponse(res, 'Only project owner can add owners', 403);
    }

    if (!['view', 'edit'].includes(permission)) {
      return errorResponse(res, 'Invalid co-owner permission. Use "view" or "edit"', 400);
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

    // Store permission level for this co-owner
    if (!project.coOwnerPermissions) {
      project.coOwnerPermissions = {} as any;
    }
    if (typeof (project.coOwnerPermissions as any).set === 'function') {
      (project.coOwnerPermissions as any).set(userId, permission);
    } else {
      (project.coOwnerPermissions as any)[userId] = permission;
    }

    // For "edit" co-owners, also add to managers array.
    // "view" co-owners stay out of managers and only remain in owners.
    if (permission === 'edit') {
      const isInManagers = project.managers.some((m: any) => {
        const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
        return managerId === userId;
      });
      if (!isInManagers) {
        project.managers.push(new Types.ObjectId(userId));
      }
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

    const mainOwnerId = project.ownerId.toString();
    const isMainOwner = mainOwnerId === req.user._id;

    // Only main/original owner can remove owners
    if (!isMainOwner) {
      return errorResponse(res, 'Only project owner can remove owners', 403);
    }

    // Cannot remove the original owner
    if (mainOwnerId === userId) {
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

    // Remove stored co-owner permission
    if (project.coOwnerPermissions) {
      if (typeof (project.coOwnerPermissions as any).delete === 'function') {
        (project.coOwnerPermissions as any).delete(userId);
      } else {
        delete (project.coOwnerPermissions as any)[userId];
      }
    }

    // Remove from managers array (added when co-owner had 'edit' permission)
    if (project.managers) {
      project.managers = project.managers.filter((m: any) => {
        const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
        return managerId !== userId;
      });
    }

    // Add back to members so they remain part of the project
    const alreadyMember = project.members.some((m: any) => {
      const memberId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
      return memberId === userId;
    });
    if (!alreadyMember) {
      project.members.push(new Types.ObjectId(userId));
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

    const mainOwnerId = project.ownerId.toString();
    const isMainOwner = mainOwnerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    // Only main/original owner can transfer ownership
    if (!isMainOwner) {
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

    if (updatedProject) decryptProjectFields(updatedProject as any);

    logger.info(`Project ownership transferred from ${req.user.email} to ${newOwner.email} for project ${decryptField(project.name, project._id.toString())}`);
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

    logger.info(`User ${userId} left project ${decryptField(project.name, project._id.toString())}`);
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

    logger.info(`List "${title}" added to project ${decryptField(project.name, project._id.toString())} by ${req.user.email}`);
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

    logger.info(`List "${listId}" updated in project ${decryptField(project.name, project._id.toString())} by ${req.user.email}`);
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

    logger.info(`List "${listId}" deleted from project ${decryptField(project.name, project._id.toString())} by ${req.user.email}`);
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

    // Owner/manager can always reorder; members need canEditProject permission
    const isManager = isProjectManager(project, req.user._id);
    if (!isManager) {
      const memberPermission = await ProjectPermission.findOne({
        projectId: id,
        userId: req.user._id
      });
      if (!memberPermission?.permissions?.canEditProject) {
        return errorResponse(res, 'You do not have permission to reorder lists', 403);
      }
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

    logger.info(`Lists reordered in project ${decryptField(project.name, project._id.toString())} by ${req.user.email}`);
    return successResponse(res, 'Lists reordered successfully', project.columns);
  } catch (error) {
    logger.error('Error reordering lists:', error);
    return internalServerErrorResponse(res, 'Failed to reorder lists');
  }
};