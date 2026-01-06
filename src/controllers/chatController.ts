import { Request, Response } from 'express';
import { ChatGroup } from '../models/ChatGroup';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { AuthenticatedRequest } from '../middleware/auth';
import { io } from '../server';
import mongoose from 'mongoose';

// Create a new chat group (Admin only)
export const createChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, memberIds, encryptionPublicKey } = req.body;

    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can create chat groups' });
    }

    // Ensure creator is included in members list
    const allMemberIds = [...new Set([req.user._id.toString(), ...memberIds])];

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

    return res.status(201).json(chatGroup);
  } catch (error) {
    console.error('Error creating chat group:', error);
    return res.status(500).json({ message: 'Failed to create chat group' });
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

    return res.json(chatGroups);
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
    const { groupId, encryptedContent, nonce, attachments } = req.body;
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

    // Create message
    const message = await Message.create({
      groupId,
      senderId,
      encryptedContent,
      nonce,
      attachments: attachments || [],
      readBy: [{ userId: senderId, readAt: new Date() }]
    });

    // Populate sender info
    await message.populate('senderId', 'displayName email photoURL');

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

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === req.user?._id;

    if (!isAdmin && !isCreator) {
      return res.status(403).json({ message: 'Only admins or group creator can delete chat groups' });
    }

    // Soft delete
    chatGroup.isActive = false;
    await chatGroup.save();

    // Notify all members
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:group:deleted', { groupId });
    });

    return res.json({ message: 'Chat group deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat group:', error);
    return res.status(500).json({ message: 'Failed to delete chat group' });
  }
};
