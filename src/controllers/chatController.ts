import { Request, Response } from 'express';
import { ChatGroup } from '../models/ChatGroup';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Project, ProjectPermission } from '../models';
import { AuditLog } from '../models/AuditLog';
import { AuthenticatedRequest } from '../middleware/auth';
import { io } from '../server';
import mongoose from 'mongoose';

// Create a new chat group (Admin only)
export const createChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, memberIds = [], encryptionPublicKey, projectId } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const isAdmin = req.user?.role === 'admin';
    let project: any = null;
    let projectMembers = new Set<string>();
    let hasPermission = false;

    // If projectId is provided, validate project and permissions
    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ message: 'Invalid projectId format' });
      }

      project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
        ? (project.ownerId as any)._id.toString()
        : project.ownerId.toString();

      const ownerIds = new Set<string>([
        ownerId,
        ...(project.owners || []).map((o: any) => (typeof o === 'object' && o._id ? o._id.toString() : o.toString()))
      ]);

      projectMembers = new Set<string>([
        ...ownerIds,
        ...(project.managers || []).map((m: any) => (typeof m === 'object' && m._id ? m._id.toString() : m.toString())),
        ...(project.members || []).map((m: any) => (typeof m === 'object' && m._id ? m._id.toString() : m.toString()))
      ]);

      if (!projectMembers.has(userId)) {
        return res.status(403).json({ message: 'You must be a member of the project to create a chat group' });
      }

      const isOwner = ownerIds.has(userId);
      hasPermission = isAdmin || isOwner;
      if (!hasPermission) {
        const permission = await ProjectPermission.findOne({ projectId, userId });
        hasPermission = !!permission?.permissions?.canCreateChatGroups;
      }

      if (!hasPermission) {
        return res.status(403).json({ message: 'You do not have permission to create chat groups for this project' });
      }
    } else {
      // No projectId - allow admins or any authenticated user to create groups
      hasPermission = true;
    }

    // Ensure creator is included in members list
    const allMemberIds = [...new Set([userId, ...(Array.isArray(memberIds) ? memberIds : [])].map(id => id.toString()))];

    // If projectId is provided, validate that all members belong to the project
    if (projectId && projectMembers.size > 0) {
      const invalidMember = allMemberIds.find(id => !projectMembers.has(id));
      if (invalidMember) {
        return res.status(400).json({ message: 'All members must belong to the selected project' });
      }
    }

    // Validate members exist and are active
    const members = await User.find({
      _id: { $in: allMemberIds },
      isActive: true
    });

    if (members.length !== allMemberIds.length) {
      return res.status(400).json({ message: 'One or more users not found or inactive' });
    }

    // Create chat group with creator included in members
    const chatGroup = await ChatGroup.create({
      name,
      description: description || '',
      createdBy: req.user._id,
      members: allMemberIds,
      projectId,
      encryptionPublicKey,
      isActive: true
    });

    // Populate members
    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email');

    // Notify all members via Socket.IO (including creator)
    allMemberIds.forEach((memberId: string) => {
      io.to(`user:${memberId}`).emit('chat:group:created', chatGroup);
    });

    // Log audit entry for project context (if projectId is provided)
    if (projectId) {
      try {
        await AuditLog.logAction({
          projectId,
          userId,
          action: 'chat_group_created',
          entityType: 'chat_group',
          entityId: chatGroup._id.toString(),
          metadata: {
            groupName: name,
            memberCount: allMemberIds.length,
            projectName: project?.name || 'Unknown'
          }
        });
      } catch (auditErr) {
        console.error('Failed to log chat group creation audit event:', auditErr);
      }
    }

    return res.status(201).json(chatGroup);
  } catch (error) {
    console.error('Error creating chat group:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error details:', {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      body: req.body
    });
    return res.status(500).json({ message: 'Failed to create chat group', error: errorMessage });
  }
};

// Get all chat groups for current user
export const getUserChatGroups = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;

    const chatGroups = await ChatGroup.find({
      members: userId,
      isActive: true
    })
      .populate('members', 'displayName email photoURL')
      .populate('createdBy', 'displayName email')
      .sort({ updatedAt: -1 });

    // For each group, get unread count and last message
    const groupsWithMetadata = await Promise.all(
      chatGroups.map(async (group) => {
        // Get last message for this group
        const lastMessage = await Message.findOne({
          groupId: group._id,
          isDeleted: false
        })
          .populate('senderId', 'displayName email photoURL')
          .sort({ createdAt: -1 })
          .lean();

        // Count unread messages for this user in this group
        const unreadCount = await Message.countDocuments({
          groupId: group._id,
          isDeleted: false,
          'readBy.userId': { $ne: userId }
        });

        return {
          ...group.toObject(),
          unreadCount,
          lastMessage: lastMessage || null
        };
      })
    );

    // Sort by last message timestamp (most recent first)
    groupsWithMetadata.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.updatedAt;
      const bTime = b.lastMessage?.createdAt || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    return res.json(groupsWithMetadata);
  } catch (error) {
    console.error('Error fetching chat groups:', error);
    return res.status(500).json({ message: 'Failed to fetch chat groups' });
  }
};

// Get a single chat group
export const getChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?._id;

    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: userId,
      isActive: true
    })
      .populate('members', 'displayName email photoURL')
      .populate('createdBy', 'displayName email');

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found or access denied' });
    }

    return res.json(chatGroup);
  } catch (error) {
    console.error('Error fetching chat group:', error);
    return res.status(500).json({ message: 'Failed to fetch chat group' });
  }
};

// Send a message to a group
export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId, encryptedContent, nonce, attachments, replyTo } = req.body;
    const senderId = req.user?._id;

    // Check if user is a member of the group
    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: senderId,
      isActive: true
    });

    if (!chatGroup) {
      return res.status(403).json({ message: 'Not authorized to send messages to this group' });
    }

    let replyToMessage: any = null;
    if (replyTo && mongoose.Types.ObjectId.isValid(replyTo)) {
      replyToMessage = await Message.findById(replyTo);
      // Ensure reply target belongs to the same group
      if (!replyToMessage || replyToMessage.groupId.toString() !== groupId) {
        replyToMessage = null;
      }
    }

    // Create message
    const message = await Message.create({
      groupId,
      senderId,
      encryptedContent,
      nonce,
      attachments: attachments || [],
      replyTo: replyToMessage?._id,
      readBy: [{ userId: senderId, readAt: new Date() }]
    });

    // Populate sender info and reply target
    await message.populate('senderId', 'displayName email photoURL');
    if (message.replyTo) {
      await message.populate({
        path: 'replyTo',
        select: 'senderId encryptedContent nonce attachments isDeleted createdAt',
        populate: { path: 'senderId', select: 'displayName email photoURL' }
      });
    }

    // Update group's updatedAt timestamp
    chatGroup.updatedAt = new Date();
    await chatGroup.save();

    // Emit to all group members via Socket.IO
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:message:new', {
        groupId,
        message
      });
    });

    return res.status(201).json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    return res.status(500).json({ message: 'Failed to send message' });
  }
};

// Get messages for a group
export const getGroupMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?._id;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;

    // Check if user is a member of the group
    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: userId,
      isActive: true
    });

    if (!chatGroup) {
      return res.status(403).json({ message: 'Not authorized to view messages in this group' });
    }

    // Get messages
    const messages = await Message.find({
      groupId,
      isDeleted: false
    })
      .populate('senderId', 'displayName email photoURL')
      .populate({
        path: 'replyTo',
        select: 'senderId encryptedContent nonce attachments isDeleted createdAt',
        populate: { path: 'senderId', select: 'displayName email photoURL' }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Get total count
    const totalCount = await Message.countDocuments({
      groupId,
      isDeleted: false
    });

    return res.json({
      messages: messages.reverse(), // Reverse to get chronological order
      totalCount,
      hasMore: skip + limit < totalCount
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

// Mark message as read
export const markMessageAsRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user already marked as read
    const alreadyRead = message.readBy.some(
      (read) => read.userId.toString() === userId?.toString()
    );

    if (!alreadyRead) {
      message.readBy.push({ userId: userId!, readAt: new Date() });
      await message.save();

      // Notify sender via Socket.IO
      io.to(`user:${message.senderId.toString()}`).emit('chat:message:read', {
        messageId,
        userId,
        groupId: message.groupId
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking message as read:', error);
    return res.status(500).json({ message: 'Failed to mark message as read' });
  }
};

// Edit a message (only sender can edit)
export const editMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const { encryptedContent, nonce } = req.body;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user is the sender
    if (message.senderId.toString() !== userId?.toString()) {
      return res.status(403).json({ message: 'You can only edit your own messages' });
    }

    // Check if message is already deleted
    if (message.isDeleted) {
      return res.status(400).json({ message: 'Cannot edit a deleted message' });
    }

    // Update message content
    message.encryptedContent = encryptedContent;
    message.nonce = nonce;
    await message.save();

    // Populate sender info
    await message.populate('senderId', 'displayName email photoURL');

    // Notify all group members via Socket.IO
    const chatGroup = await ChatGroup.findById(message.groupId);
    if (chatGroup) {
      chatGroup.members.forEach((memberId) => {
        io.to(`user:${memberId.toString()}`).emit('chat:message:updated', {
          groupId: message.groupId,
          message
        });
      });
    }

    return res.json(message);
  } catch (error) {
    console.error('Error editing message:', error);
    return res.status(500).json({ message: 'Failed to edit message' });
  }
};

// Delete a message (sender or admin/group creator can delete)
export const deleteMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user is the sender of the message
    // Users can only delete their own messages
    const isSender = message.senderId.toString() === userId?.toString();

    if (!isSender) {
      return res.status(403).json({ message: 'You can only delete your own messages' });
    }

    const chatGroup = await ChatGroup.findById(message.groupId);
    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Soft delete
    message.isDeleted = true;
    await message.save();

    // Populate sender info
    await message.populate('senderId', 'displayName email photoURL');

    // Notify all group members via Socket.IO
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:message:deleted', {
        groupId: message.groupId,
        message
      });
    });

    return res.json({ success: true, message });
  } catch (error) {
    console.error('Error deleting message:', error);
    return res.status(500).json({ message: 'Failed to delete message' });
  }
};

// Add members to a group (Admin or group creator only)
export const addMembersToGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const { memberIds } = req.body;

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === req.user?._id;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ message: 'Only admins or group creator can add members' });
    }

    // Validate members exist and are active
    const members = await User.find({
      _id: { $in: memberIds },
      isActive: true
    });

    if (members.length !== memberIds.length) {
      return res.status(400).json({ message: 'One or more users not found or inactive' });
    }

    // Add new members (avoid duplicates)
    const newMemberIds = memberIds.filter(
      (id: string) => !chatGroup.members.some((m) => m.toString() === id)
    );

    chatGroup.members.push(...newMemberIds);
    await chatGroup.save();

    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email photoURL');

    // Notify new members
    newMemberIds.forEach((memberId: string) => {
      io.to(`user:${memberId}`).emit('chat:group:added', chatGroup);
    });

    // Notify existing members
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
    });

    return res.json(chatGroup);
  } catch (error) {
    console.error('Error adding members:', error);
    return res.status(500).json({ message: 'Failed to add members' });
  }
};

// Remove member from group (Admin or group creator only)
export const removeMemberFromGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId, userId } = req.params;

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === req.user?._id;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ message: 'Only admins or group creator can remove members' });
    }

    // Remove member
    chatGroup.members = chatGroup.members.filter(
      (m) => m.toString() !== userId
    );
    await chatGroup.save();

    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email photoURL');

    // Notify removed member
    io.to(`user:${userId}`).emit('chat:group:removed', { groupId });

    // Notify remaining members
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
    });

    return res.json(chatGroup);
  } catch (error) {
    console.error('Error removing member:', error);
    return res.status(500).json({ message: 'Failed to remove member' });
  }
};

// Update a chat group (Admin or group creator only)
export const updateChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const { name, description } = req.body;

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === req.user?._id;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ message: 'Only admins or group creator can update chat groups' });
    }

    // Update fields
    if (name !== undefined) chatGroup.name = name;
    if (description !== undefined) chatGroup.description = description;

    await chatGroup.save();
    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email');

    // Notify all members
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
    });

    return res.json(chatGroup);
  } catch (error) {
    console.error('Error updating chat group:', error);
    return res.status(500).json({ message: 'Failed to update chat group' });
  }
};

// Delete a chat group (Admin or group creator only)
export const deleteChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?._id?.toString();

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator (with project-scoped permission)
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === userId;

    let project: any = null;
    let canDelete = isAdmin;

    if (chatGroup.projectId) {
      project = await Project.findById(chatGroup.projectId);

      if (project) {
        const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
          ? (project.ownerId as any)._id.toString()
          : project.ownerId.toString();

        const ownerIds = new Set<string>([
          ownerId,
          ...(project.owners || []).map((o: any) => (typeof o === 'object' && o._id ? o._id.toString() : o.toString()))
        ]);

        const isOwner = userId ? ownerIds.has(userId) : false;

        if (isOwner) {
          canDelete = true;
        } else if (isCreator && userId) {
          const permission = await ProjectPermission.findOne({ projectId: chatGroup.projectId, userId });
          canDelete = !!permission?.permissions?.canDeleteChatGroups;
        }
      }
    } else if (isCreator) {
      // Legacy groups without project association can still be deleted by creator
      canDelete = true;
    }

    if (!canDelete) {
      return res.status(403).json({ message: 'You do not have permission to delete this chat group' });
    }

    // Soft delete
    chatGroup.isActive = false;
    await chatGroup.save();

    // Notify all members
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:group:deleted', { groupId });
    });

    if (chatGroup.projectId) {
      try {
        await AuditLog.logAction({
          projectId: chatGroup.projectId.toString(),
          userId: userId || '',
          action: 'chat_group_deleted',
          entityType: 'chat_group',
          entityId: groupId,
          metadata: {
            groupName: chatGroup.name,
            projectName: project?.name
          }
        });
      } catch (auditErr) {
        console.error('Failed to log chat group deletion audit event:', auditErr);
      }
    }

    return res.json({ message: 'Chat group deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat group:', error);
    return res.status(500).json({ message: 'Failed to delete chat group' });
  }
};
