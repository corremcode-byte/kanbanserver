import { Request, Response } from 'express';
import { ChatGroup } from '../models/ChatGroup';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { AuthenticatedRequest } from '../middleware/auth';
import { io } from '../server';
import mongoose from 'mongoose';
import { pushNotificationService } from '../services/pushNotificationService';
import { createNotification } from './notificationController';
import { Notification } from '../models/Notification';
import { convertPhotoURLsToAbsolute } from '../utils/urlHelper';

// Create a new chat group (Admin or user with createGroups permission)
export const createChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, memberIds, encryptionPublicKey } = req.body;

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Check if user has createGroups permission
    // Note: Admin role no longer bypasses permission checks
    const user = await User.findById(userId);
    const hasCreateGroupsPermission = user?.permissions?.modules?.chat?.createGroups === true;

    if (!hasCreateGroupsPermission) {
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
      
      // Note: Admin role no longer bypasses permission checks
      const hasChatViewPermission = member.permissions?.modules?.chat?.view === true;

      if (!hasChatViewPermission) {
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

    // Send push notifications to new members (excluding creator)
    const creatorName = req.user.displayName || req.user.email || 'Someone';
    const otherMemberIds = allMemberIds.filter((id: string) => id !== userId);

    otherMemberIds.forEach(async (memberId: string) => {
      try {
        await createNotification({
          userId: memberId,
          type: 'group_added',
          title: 'Added to Chat Group',
          message: `${creatorName} added you to the group "${chatGroup.name}"`,
          metadata: {
            groupId: chatGroup._id as mongoose.Types.ObjectId,
            groupName: chatGroup.name,
            actionBy: userId as unknown as mongoose.Types.ObjectId,
            actionByName: creatorName,
          },
        });
      } catch (error) {
        console.error(`Failed to create notification for user ${memberId}:`, error);
      }
    });

    return res.status(201).json(chatGroup);
  } catch (error) {
    console.error('Error creating chat group:', error);
    return res.status(500).json({ message: 'Failed to create chat group' });
  }
};

// Get or create "Message Yourself" group for current user
export const getOrCreateSelfChatGroup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId?.toString();

    if (!userIdString) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Check if self-chat group already exists
    let selfChatGroup = await ChatGroup.findOne({
      createdBy: userId,
      members: { $size: 1, $all: [userId] },
      name: 'Message Yourself',
      isActive: true
    })
      .populate('members', 'displayName email photoURL')
      .populate('createdBy', 'displayName email');

    // If doesn't exist, create it
    if (!selfChatGroup) {
      // Generate a simple encryption key for this group
      const encryptionPublicKey = `self-chat-${userIdString}`;

      selfChatGroup = await ChatGroup.create({
        name: 'Message Yourself',
        description: 'Your personal space for notes and reminders',
        createdBy: userId,
        members: [userId],
        encryptionPublicKey,
        isActive: true
      });

      await selfChatGroup.populate('members', 'displayName email photoURL');
      await selfChatGroup.populate('createdBy', 'displayName email');

      // Notify user via Socket.IO
      io.to(`user:${userIdString}`).emit('chat:group:created', selfChatGroup);
    }

    return res.json(selfChatGroup);
  } catch (error) {
    console.error('Error getting/creating self-chat group:', error);
    return res.status(500).json({ message: 'Failed to get self-chat group' });
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

        // Check if this is a self-chat group (only one member and it's the user)
        const isSelfChat = group.members.length === 1 &&
                          group.members[0]._id.toString() === userId?.toString() &&
                          group.name === 'Message Yourself';

        return {
          ...group.toObject(),
          unreadCount,
          lastMessage: lastMessage || null,
          isSelfChat
        };
      })
    );

    // Sort by last message timestamp (most recent first)
    groupsWithMetadata.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.updatedAt;
      const bTime = b.lastMessage?.createdAt || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    // Convert all photoURLs to absolute URLs
    const groupsWithAbsoluteUrls = convertPhotoURLsToAbsolute(groupsWithMetadata, req);

    return res.json(groupsWithAbsoluteUrls);
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

    // Convert photoURLs to absolute URLs
    const groupWithAbsoluteUrls = convertPhotoURLsToAbsolute(chatGroup.toObject(), req);

    return res.json(groupWithAbsoluteUrls);
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

    // Check if user has sendMessages permission (group creators can always send)
    // Note: Admin role no longer bypasses permission checks
    const isGroupCreator = chatGroup.createdBy.toString() === userId;

    if (!isGroupCreator) {
      const user = await User.findById(userId);
      const hasSendMessagesPermission = user?.permissions?.modules?.chat?.sendMessages === true;
      if (!hasSendMessagesPermission) {
        return res.status(403).json({ message: 'You do not have permission to send messages' });
      }

      // Check for voice recording permission if message contains audio attachments
      const hasAudioAttachment = attachments && attachments.some((att: { fileType?: string; fileName?: string }) =>
        att.fileType?.startsWith('audio/') ||
        att.fileName?.endsWith('.webm') ||
        att.fileName?.endsWith('.mp3') ||
        att.fileName?.endsWith('.ogg') ||
        att.fileName?.endsWith('.wav') ||
        att.fileName?.startsWith('voice_message_')
      );

      if (hasAudioAttachment) {
        const hasVoiceRecordingPermission = user?.permissions?.modules?.chat?.voiceRecording === true;
        if (!hasVoiceRecordingPermission) {
          return res.status(403).json({ message: 'You do not have permission to send voice messages' });
        }
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

    // Populate sender info and replyTo
    await message.populate('senderId', 'displayName email photoURL');
    if (replyTo) {
      await message.populate({
        path: 'replyTo',
        populate: { path: 'senderId', select: 'displayName email photoURL' }
      });
    }

    // Update group's updatedAt timestamp
    chatGroup.updatedAt = new Date();
    await chatGroup.save();

    // Emit to all group members via Socket.IO with absolute photoURLs
    const messageWithAbsoluteUrls = convertPhotoURLsToAbsolute(message.toObject(), req);
    chatGroup.members.forEach((memberId) => {
      io.to(`user:${memberId.toString()}`).emit('chat:message:new', {
        groupId,
        message: messageWithAbsoluteUrls
      });
    });

    // Send notifications to members who are not the sender
    // Get sender's display name for the notification
    const sender = await User.findById(senderId);
    const senderName = sender?.displayName || sender?.email || 'Someone';

    // Send notifications to all other members
    const otherMembers = chatGroup.members.filter(
      (memberId) => memberId.toString() !== userId
    );

    // Get users actively viewing this chat room right now via socket.
    // socket.data.userId is set at connect time in socketHandlers so RemoteSocket can expose it.
    const chatRoom = `chat:${groupId}`;
    const socketsInRoom = await io.in(chatRoom).fetchSockets();
    const userIdsActiveInChat = new Set(
      socketsInRoom.map((s: any) => s.data?.userId).filter(Boolean)
    );

    // Create in-app notifications and send push notifications
    otherMembers.forEach(async (memberId) => {
      try {
        const memberIdStr = memberId.toString();

        // Skip: member is currently viewing this chat — they already see the message live
        if (userIdsActiveInChat.has(memberIdStr)) {
          return;
        }

        // Skip: member has already read this message (opened on another tab/device)
        const alreadyRead = message.readBy?.some(
          (r: any) => r.userId?.toString() === memberIdStr
        );
        if (alreadyRead) {
          return;
        }

        await createNotification({
          userId: memberIdStr,
          type: 'chat_message',
          title: `New message from ${senderName}`,
          message: `You have a new message in ${chatGroup.name}`,
          metadata: {
            groupId: chatGroup._id as mongoose.Types.ObjectId,
            groupName: chatGroup.name,
            messageId: message._id as mongoose.Types.ObjectId,
            actionBy: userId as unknown as mongoose.Types.ObjectId,
            actionByName: senderName,
          },
        });
      } catch (error) {
        console.error(`Failed to create notification for user ${memberId}:`, error);
      }
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

    // Convert messages to plain objects and normalize readBy userId to strings
    // (ObjectIds in readBy are not populated, so they must be stringified before
    // convertPhotoURLsToAbsolute recurses into them and corrupts them)
    // Convert messages to plain objects and normalize readBy userId to strings
    // (ObjectIds in readBy are not populated, so they must be stringified before
    // convertPhotoURLsToAbsolute recurses into them and corrupts them)
    const plainMessages = messages.map(m => {
      const obj = m.toObject() as unknown as Record<string, unknown>;
      const readBy = obj.readBy as { userId: unknown; readAt: unknown }[] | undefined;
      obj.readBy = (readBy || []).map(r => ({
        ...r,
        userId: r.userId ? String(r.userId) : r.userId
      }));
      return obj;
    });

    // Convert photoURLs to absolute URLs
    const messagesWithAbsoluteUrls = convertPhotoURLsToAbsolute(plainMessages, req);

    return res.json({
      messages: messagesWithAbsoluteUrls.reverse(), // Reverse to get chronological order
      totalCount,
      hasMore: skip + limit < totalCount
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

// Get starred messages for current user in a group
export const getGroupStarredMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?._id;
    const limit = parseInt(req.query.limit as string) || 100;
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

    // Get messages starred by current user
    const messages = await Message.find({
      groupId,
      isDeleted: false,
      starredBy: userId
    })
      .populate('senderId', 'displayName email photoURL')
      .populate({
        path: 'replyTo',
        populate: { path: 'senderId', select: 'displayName email photoURL' }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalCount = await Message.countDocuments({
      groupId,
      isDeleted: false,
      starredBy: userId
    });

    const plainMessages = messages.map(m => {
      const obj = m.toObject() as unknown as Record<string, unknown>;
      const readBy = obj.readBy as { userId: unknown; readAt: unknown }[] | undefined;
      obj.readBy = (readBy || []).map(r => ({
        ...r,
        userId: r.userId ? String(r.userId) : r.userId
      }));
      return obj;
    });

    const messagesWithAbsoluteUrls = convertPhotoURLsToAbsolute(plainMessages, req);

    return res.json({
      messages: messagesWithAbsoluteUrls,
      totalCount,
      hasMore: skip + limit < totalCount
    });
  } catch (error) {
    console.error('Error fetching starred messages:', error);
    return res.status(500).json({ message: 'Failed to fetch starred messages' });
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

      // Mark related chat notifications as read for this user.
      await Notification.updateMany(
        {
          userId: userId,
          type: 'chat_message',
          read: false,
          $or: [
            { 'metadata.messageId': message._id },
            {
              'metadata.groupId': message.groupId,
              'metadata.actionBy': message.senderId
            }
          ]
        },
        {
          $set: {
            read: true,
            readAt: new Date()
          }
        }
      );

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

    // Check if message is older than 24 hours
    const hoursSinceCreation = (Date.now() - new Date(message.createdAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreation > 24) {
      return res.status(400).json({ message: 'Cannot edit a message older than 24 hours' });
    }

    // Update message content
    message.encryptedContent = encryptedContent;
    message.nonce = nonce;
    message.isEdited = true;
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

// Delete a message (sender with deleteMessages permission or admin/group creator can delete)
export const deleteMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user is the sender of the message
    const isSender = message.senderId.toString() === userId?.toString();

    // Check if user has deleteMessages permission
    // Note: Admin role no longer bypasses permission checks
    const user = await User.findById(userId);
    const hasDeleteMessagesPermission = user?.permissions?.modules?.chat?.deleteMessages === true;

    // Get chat group to check if user is the group creator
    const chatGroup = await ChatGroup.findById(message.groupId);
    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    const isGroupCreator = chatGroup.createdBy.toString() === userId?.toString();

    // Users can delete if: (group creator OR (own message AND has deleteMessages permission))
    const canDelete = isGroupCreator || (isSender && hasDeleteMessagesPermission);

    if (!canDelete) {
      return res.status(403).json({ message: 'You do not have permission to delete messages' });
    }

    if (!isSender && !isGroupCreator) {
      return res.status(403).json({ message: 'You can only delete your own messages' });
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

// Toggle emoji reaction on a message
export const toggleReaction = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user?._id;

    if (!emoji) {
      return res.status(400).json({ message: 'Emoji is required' });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Check if user already reacted with this emoji
    const existingReactionIndex = message.reactions.findIndex(
      (r) => r.userId.toString() === userId?.toString() && r.emoji === emoji
    );

    if (existingReactionIndex > -1) {
      // Remove the reaction (toggle off)
      message.reactions.splice(existingReactionIndex, 1);
    } else {
      // Remove any existing reaction from this user (one reaction per user)
      const userReactionIndex = message.reactions.findIndex(
        (r) => r.userId.toString() === userId?.toString()
      );
      if (userReactionIndex > -1) {
        message.reactions.splice(userReactionIndex, 1);
      }
      // Add the new reaction
      message.reactions.push({
        userId: userId as any,
        emoji,
        createdAt: new Date()
      });
    }

    await message.save();
    await message.populate('senderId', 'displayName email photoURL');
    await message.populate('reactions.userId', 'displayName email photoURL');

    // Notify all group members via Socket.IO
    const chatGroup = await ChatGroup.findById(message.groupId);
    if (chatGroup) {
      chatGroup.members.forEach((memberId) => {
        io.to(`user:${memberId.toString()}`).emit('chat:message:reacted', {
          groupId: message.groupId,
          message
        });
      });
    }

    return res.json({ success: true, message });
  } catch (error) {
    console.error('Error toggling reaction:', error);
    return res.status(500).json({ message: 'Failed to toggle reaction' });
  }
};

// Toggle pin on a message
export const togglePin = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    message.isPinned = !message.isPinned;
    message.pinnedBy = message.isPinned ? (userId as any) : undefined;
    await message.save();

    await message.populate('senderId', 'displayName email photoURL');

    // Notify all group members via Socket.IO
    const chatGroup = await ChatGroup.findById(message.groupId);
    if (chatGroup) {
      chatGroup.members.forEach((memberId) => {
        io.to(`user:${memberId.toString()}`).emit('chat:message:pinned', {
          groupId: message.groupId,
          message
        });
      });
    }

    return res.json({ success: true, message });
  } catch (error) {
    console.error('Error toggling pin:', error);
    return res.status(500).json({ message: 'Failed to toggle pin' });
  }
};

// Toggle star on a message (per-user)
export const toggleStar = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const userId = req.user?._id;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    const starIndex = message.starredBy.findIndex(
      (id) => id.toString() === userId?.toString()
    );

    if (starIndex > -1) {
      message.starredBy.splice(starIndex, 1);
    } else {
      message.starredBy.push(userId as any);
    }

    await message.save();
    await message.populate('senderId', 'displayName email photoURL');

    return res.json({
      success: true,
      message,
      isStarred: starIndex === -1
    });
  } catch (error) {
    console.error('Error toggling star:', error);
    return res.status(500).json({ message: 'Failed to toggle star' });
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

    // Check if user is the group creator or has manageGroupMembers permission
    // Note: Admin role no longer bypasses permission checks
    const isCreator = chatGroup.createdBy.toString() === userId;

    let hasManagePermission = false;
    if (!isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.manageGroupMembers === true) {
        hasManagePermission = true;
      }
    }

    if (!isCreator && !hasManagePermission) {
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
      // Note: Admin role no longer bypasses permission checks
      const hasChatViewPermission = member.permissions?.modules?.chat?.view === true;

      if (!hasChatViewPermission) {
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

    // Send push notifications to new members
    const currentUser = await User.findById(userId);
    const adderName = currentUser?.displayName || currentUser?.email || 'Someone';

    newMemberIds.forEach(async (memberId: string) => {
      try {
        await createNotification({
          userId: memberId,
          type: 'group_added',
          title: 'Added to Chat Group',
          message: `${adderName} added you to the group "${chatGroup.name}"`,
          metadata: {
            groupId: chatGroup._id as mongoose.Types.ObjectId,
            groupName: chatGroup.name,
            actionBy: userId as unknown as mongoose.Types.ObjectId,
            actionByName: adderName,
          },
        });
      } catch (error) {
        console.error(`Failed to create notification for user ${memberId}:`, error);
      }
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

    // Check if user is the group creator or has manageGroupMembers permission
    // Note: Admin role no longer bypasses permission checks
    const isCreator = chatGroup.createdBy.toString() === userId;

    let hasManagePermission = false;
    if (!isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.manageGroupMembers === true) {
        hasManagePermission = true;
      }
    }

    if (!isCreator && !hasManagePermission) {
      return res.status(403).json({ message: 'You do not have permission to remove members from this group' });
    }

    // Remove member
    chatGroup.members = chatGroup.members.filter(
      (m) => m.toString() !== memberToRemoveId
    );
    await chatGroup.save();

    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email photoURL');

    // Notify removed member
    io.to(`user:${memberToRemoveId}`).emit('chat:group:removed', { groupId });

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

    // Check if user is the group creator or has editGroups permission
    // Note: Admin role no longer bypasses permission checks
    const isCreator = chatGroup.createdBy.toString() === userId;

    let hasEditGroupsPermission = false;
    if (!isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.editGroups === true) {
        hasEditGroupsPermission = true;
      }
    }

    if (!isCreator && !hasEditGroupsPermission) {
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

    // Check if user is the group creator or has deleteGroups permission
    // Note: Admin role no longer bypasses permission checks
    const isCreator = chatGroup.createdBy.toString() === userId;

    let hasDeleteGroupsPermission = false;
    if (!isCreator) {
      const user = await User.findById(userId);
      if (user?.permissions?.modules?.chat?.deleteGroups === true) {
        hasDeleteGroupsPermission = true;
      }
    }

    if (!isCreator && !hasDeleteGroupsPermission) {
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

// ==========================================
// PLATFORM USERS FOR FORWARDING
// ==========================================

// Get all platform users with their chat permission status (for forward modal)
export const getPlatformUsersForChat = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;
    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const users = await User.find({
      _id: { $ne: currentUserId },
      isActive: true,
      role: { $ne: 'superadmin' }
    }).select('_id displayName email photoURL permissions');

    const usersWithPermission = users.map(user => {
      const chatPerms = user.permissions?.modules?.chat;
      const hasChatPermission = chatPerms?.view === true;
      return {
        _id: user._id,
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        hasChatPermission
      };
    });

    const usersWithAbsoluteUrls = convertPhotoURLsToAbsolute(usersWithPermission, req);

    return res.json({ users: usersWithAbsoluteUrls });
  } catch (error) {
    console.error('Error getting platform users for chat:', error);
    return res.status(500).json({ message: 'Failed to get platform users' });
  }
};

// ==========================================
// SUPER ADMIN ENDPOINTS
// ==========================================

// Super Admin: Get all users for chat surveillance
export const superAdminGetAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await User.find({ isActive: true })
      .select('_id displayName email photoURL username role')
      .sort({ displayName: 1 });

    // Convert photoURLs to absolute URLs
    const usersWithAbsoluteUrls = convertPhotoURLsToAbsolute(
      users.map(u => u.toObject()),
      req
    );

    return res.json(usersWithAbsoluteUrls);
  } catch (error) {
    console.error('Error fetching users for super admin:', error);
    return res.status(500).json({ message: 'Failed to fetch users' });
  }
};

// Super Admin: Get all chat groups for a specific user
export const superAdminGetUserChatGroups = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = req.params;

    // Validate user exists
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get ALL chat groups where this user is a member (including deleted/inactive for full visibility)
    const chatGroups = await ChatGroup.find({
      members: userId
    })
      .populate('members', 'displayName email photoURL')
      .populate('createdBy', 'displayName email')
      .sort({ updatedAt: -1 });

    // For each group, get last message and total message count
    const groupsWithMetadata = await Promise.all(
      chatGroups.map(async (group) => {
        const lastMessage = await Message.findOne({
          groupId: group._id,
          isDeleted: false
        })
          .populate('senderId', 'displayName email photoURL')
          .sort({ createdAt: -1 })
          .lean();

        const totalMessages = await Message.countDocuments({
          groupId: group._id
        });

        const deletedMessages = await Message.countDocuments({
          groupId: group._id,
          isDeleted: true
        });

        const isSelfChat = group.members.length === 1 &&
          group.members[0]._id.toString() === userId &&
          group.name === 'Message Yourself';

        return {
          ...group.toObject(),
          lastMessage: lastMessage || null,
          totalMessages,
          deletedMessages,
          isSelfChat
        };
      })
    );

    // Sort by last message timestamp
    groupsWithMetadata.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.updatedAt;
      const bTime = b.lastMessage?.createdAt || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    const groupsWithAbsoluteUrls = convertPhotoURLsToAbsolute(groupsWithMetadata, req);

    return res.json({
      user: {
        _id: targetUser._id,
        displayName: targetUser.displayName,
        email: targetUser.email,
        username: targetUser.username
      },
      groups: groupsWithAbsoluteUrls
    });
  } catch (error) {
    console.error('Error fetching user chat groups for super admin:', error);
    return res.status(500).json({ message: 'Failed to fetch user chat groups' });
  }
};

// Super Admin: Get all messages for a group (INCLUDING deleted messages)
export const superAdminGetGroupMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { groupId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;

    // Validate group exists
    const chatGroup = await ChatGroup.findById(groupId);
    if (!chatGroup) {
      return res.status(404).json({ message: 'Chat group not found' });
    }

    // Get ALL messages INCLUDING deleted ones (no isDeleted filter)
    const messages = await Message.find({ groupId })
      .populate('senderId', 'displayName email photoURL')
      .populate({
        path: 'replyTo',
        populate: { path: 'senderId', select: 'displayName email photoURL' }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Get total count (including deleted)
    const totalCount = await Message.countDocuments({ groupId });

    const plainMessages2 = messages.map(m => {
      const obj = m.toObject() as unknown as Record<string, unknown>;
      const readBy = obj.readBy as { userId: unknown; readAt: unknown }[] | undefined;
      obj.readBy = (readBy || []).map(r => ({
        ...r,
        userId: r.userId ? String(r.userId) : r.userId
      }));
      return obj;
    });

    const messagesWithAbsoluteUrls = convertPhotoURLsToAbsolute(plainMessages2, req);

    // Get group details with members
    await chatGroup.populate('members', 'displayName email photoURL');
    await chatGroup.populate('createdBy', 'displayName email');

    return res.json({
      group: convertPhotoURLsToAbsolute(chatGroup.toObject(), req),
      messages: messagesWithAbsoluteUrls.reverse(),
      totalCount,
      hasMore: skip + limit < totalCount
    });
  } catch (error) {
    console.error('Error fetching group messages for super admin:', error);
    return res.status(500).json({ message: 'Failed to fetch group messages' });
  }
};

// Create or get a personal chat between two users
export const createOrGetPersonalChat = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId: otherUserId } = req.body;
    const currentUserId = req.user?._id?.toString();

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!otherUserId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    if (currentUserId === otherUserId) {
      return res.status(400).json({ message: 'Cannot create a personal chat with yourself' });
    }

    // Check if current user has personalChat permission
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ message: 'Current user not found' });
    }

    // Note: Admin role no longer bypasses permission checks
    const hasPersonalChatPermission = currentUser.permissions?.modules?.chat?.personalChat === true;

    if (!hasPersonalChatPermission) {
      return res.status(403).json({
        message: 'You do not have permission to create personal chats'
      });
    }

    // Validate that the other user exists and is active
    const otherUser = await User.findById(otherUserId);
    if (!otherUser || !otherUser.isActive) {
      return res.status(404).json({ message: 'User not found or inactive' });
    }

    // Check if other user has chat.view permission
    // Note: Admin role no longer bypasses permission checks
    const hasChatViewPermission = otherUser.permissions?.modules?.chat?.view === true;

    if (!hasChatViewPermission) {
      return res.status(400).json({
        message: `Cannot create a personal chat because ${otherUser.displayName || otherUser.email} does not have access to chats`
      });
    }

    // Check if a personal chat (2-member group) already exists between these two users
    const existingPersonalChat = await ChatGroup.findOne({
      members: { $all: [currentUserId, otherUserId], $size: 2 },
      isActive: true
    })
      .populate('members', 'displayName email photoURL')
      .populate('createdBy', 'displayName email');

    if (existingPersonalChat) {
      // Get last message and unread count
      const lastMessage = await Message.findOne({
        groupId: existingPersonalChat._id,
        isDeleted: false
      })
        .populate('senderId', 'displayName email photoURL')
        .sort({ createdAt: -1 })
        .lean();

      const unreadCount = await Message.countDocuments({
        groupId: existingPersonalChat._id,
        isDeleted: false,
        'readBy.userId': { $ne: currentUserId }
      });

      return res.json({
        ...existingPersonalChat.toObject(),
        unreadCount,
        lastMessage: lastMessage || null
      });
    }

    // Create a new personal chat
    // Generate a deterministic name based on the other user's name
    const chatName = otherUser.displayName || otherUser.email;
    const encryptionPublicKey = req.body.encryptionPublicKey || '';

    const personalChat = await ChatGroup.create({
      name: chatName,
      description: '',
      createdBy: currentUserId,
      members: [currentUserId, otherUserId],
      encryptionPublicKey,
      isActive: true
    });

    // Populate members
    await personalChat.populate('members', 'displayName email photoURL');
    await personalChat.populate('createdBy', 'displayName email');

    // Notify both users via Socket.IO
    io.to(`user:${currentUserId}`).emit('chat:group:created', personalChat);
    io.to(`user:${otherUserId}`).emit('chat:group:created', personalChat);

    return res.status(201).json({
      ...personalChat.toObject(),
      unreadCount: 0,
      lastMessage: null
    });
  } catch (error) {
    console.error('Error creating/getting personal chat:', error);
    return res.status(500).json({ message: 'Failed to create/get personal chat' });
  }
};
