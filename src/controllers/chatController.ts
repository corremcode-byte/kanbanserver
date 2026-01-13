import { Request, Response } from 'express';
import { ChatGroup } from '../models/ChatGroup';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { AuthenticatedRequest } from '../middleware/auth';
import { io } from '../server';
import mongoose from 'mongoose';

// Create a new chat group (Admin or user with createGroups permission)
export const createChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, memberIds, encryptionPublicKey } = req.body;

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Check if user is admin
    const isAdmin = req.user?.role === 'admin';
    
    // Check if user has createGroups permission
    let hasCreateGroupsPermission = false;
    if (!isAdmin) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.createGroups === true) {
        hasCreateGroupsPermission = true;
      }
    }

    if (!isAdmin && !hasCreateGroupsPermission) {
      return res.status(403).json({ message: 'You do not have permission to create chat groups' });
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

    // Check if all members have chat.view permission (excluding the creator who is creating the group)
    const usersWithoutChatPermission: string[] = [];
    members.forEach((member) => {
      // Skip checking the creator's permission as they're creating the group
      if (member._id.toString() === userId) {
        return;
      }
      
      const isMemberAdmin = member.role === 'admin';
      const hasChatViewPermission = member.permissions?.modules?.chat?.view === true;
      
      if (!isMemberAdmin && !hasChatViewPermission) {
        usersWithoutChatPermission.push(member.displayName || member.email);
      }
    });

    if (usersWithoutChatPermission.length > 0) {
      return res.status(400).json({ 
        message: `Group cannot be created because some users do not have access to chats: ${usersWithoutChatPermission.join(', ')}` 
      });
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
    const userId = senderId?.toString();

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Check if user is a member of the group
    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: senderId,
      isActive: true
    });

    if (!chatGroup) {
      return res.status(403).json({ message: 'Not authorized to send messages to this group' });
    }

    // Check if user has sendMessages permission (admins and group creators can always send)
    const isAdmin = req.user?.role === 'admin';
    const isGroupCreator = chatGroup.createdBy.toString() === userId;
    
    if (!isAdmin && !isGroupCreator) {
      const user = await User.findById(userId);
      const hasSendMessagesPermission = user?.permissions?.modules?.chat?.sendMessages === true;
      if (!hasSendMessagesPermission) {
        return res.status(403).json({ message: 'You do not have permission to send messages' });
      }
    }

    // Create message
    const messageData: any = {
      groupId,
      senderId,
      encryptedContent,
      nonce,
      attachments: attachments || [],
      readBy: [{ userId: senderId, readAt: new Date() }]
    };

    // Add replyTo if provided
    if (replyTo) {
      messageData.replyTo = replyTo;
    }

    const message = await Message.create(messageData);

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

// Add members to a group (Admin, group creator, or user with manageGroupMembers permission)
export const addMembersToGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const { memberIds } = req.body;

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === userId;

    // Check if user has manageGroupMembers permission
    let hasManagePermission = false;
    if (!isAdmin && !isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.manageGroupMembers === true) {
        hasManagePermission = true;
      }
    }

    if (!isAdmin && !isCreator && !hasManagePermission) {
      return res.status(403).json({ message: 'You do not have permission to add members to this group' });
    }

    // Validate members exist and are active
    const members = await User.find({
      _id: { $in: memberIds },
      isActive: true
    });

    if (members.length !== memberIds.length) {
      return res.status(400).json({ message: 'One or more users not found or inactive' });
    }

    // Check if all members have chat.view permission
    const usersWithoutChatPermission: string[] = [];
    members.forEach((member) => {
      const isMemberAdmin = member.role === 'admin';
      const hasChatViewPermission = member.permissions?.modules?.chat?.view === true;
      
      if (!isMemberAdmin && !hasChatViewPermission) {
        usersWithoutChatPermission.push(member.displayName || member.email);
      }
    });

    if (usersWithoutChatPermission.length > 0) {
      return res.status(400).json({ 
        message: `Cannot add user(s) to group because they do not have permission to view chats: ${usersWithoutChatPermission.join(', ')}` 
      });
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

// Remove member from group (Admin, group creator, or user with manageGroupMembers permission)
export const removeMemberFromGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId, userId: memberToRemoveId } = req.params;

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === userId;

    // Check if user has manageGroupMembers permission
    let hasManagePermission = false;
    if (!isAdmin && !isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.manageGroupMembers === true) {
        hasManagePermission = true;
      }
    }

    if (!isAdmin && !isCreator && !hasManagePermission) {
      return res.status(403).json({ message: 'You do not have permission to remove members from this group' });
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

// Update a chat group (Admin, group creator, or user with editGroups permission)
export const updateChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const { name, description } = req.body;

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === userId;

    // Check if user has editGroups permission
    let hasEditGroupsPermission = false;
    if (!isAdmin && !isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.editGroups === true) {
        hasEditGroupsPermission = true;
      }
    }

    if (!isAdmin && !isCreator && !hasEditGroupsPermission) {
      return res.status(403).json({ message: 'You do not have permission to update chat groups' });
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

// Delete a chat group (Admin, group creator, or user with deleteGroups permission)
export const deleteChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const chatGroup = await ChatGroup.findById(groupId);

    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Check if user is admin or the group creator
    const isAdmin = req.user?.role === 'admin';
    const isCreator = chatGroup.createdBy.toString() === userId;

    // Check if user has deleteGroups permission
    let hasDeleteGroupsPermission = false;
    if (!isAdmin && !isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.deleteGroups === true) {
        hasDeleteGroupsPermission = true;
      }
    }

    if (!isAdmin && !isCreator && !hasDeleteGroupsPermission) {
      return res.status(403).json({ message: 'You do not have permission to delete chat groups' });
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
