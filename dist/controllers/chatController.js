"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteChatGroup = exports.updateChatGroup = exports.removeMemberFromGroup = exports.addMembersToGroup = exports.deleteMessage = exports.editMessage = exports.markMessageAsRead = exports.getGroupMessages = exports.sendMessage = exports.getChatGroup = exports.getUserChatGroups = exports.createChatGroup = void 0;
const ChatGroup_1 = require("../models/ChatGroup");
const Message_1 = require("../models/Message");
const User_1 = require("../models/User");
const models_1 = require("../models");
const AuditLog_1 = require("../models/AuditLog");
const server_1 = require("../server");
const mongoose_1 = __importDefault(require("mongoose"));
const createChatGroup = async (req, res) => {
    try {
        const { name, description, memberIds = [], encryptionPublicKey, projectId } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Group name is required' });
        }
        const userId = req.user?._id?.toString();
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        const isAdmin = req.user?.role === 'admin';
        let project = null;
        let projectMembers = new Set();
        let hasPermission = false;
        if (projectId) {
            if (!mongoose_1.default.Types.ObjectId.isValid(projectId)) {
                return res.status(400).json({ message: 'Invalid projectId format' });
            }
            project = await models_1.Project.findById(projectId);
            if (!project) {
                return res.status(404).json({ message: 'Project not found' });
            }
            const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
                ? project.ownerId._id.toString()
                : project.ownerId.toString();
            const ownerIds = new Set([
                ownerId,
                ...(project.owners || []).map((o) => (typeof o === 'object' && o._id ? o._id.toString() : o.toString()))
            ]);
            projectMembers = new Set([
                ...ownerIds,
                ...(project.managers || []).map((m) => (typeof m === 'object' && m._id ? m._id.toString() : m.toString())),
                ...(project.members || []).map((m) => (typeof m === 'object' && m._id ? m._id.toString() : m.toString()))
            ]);
            if (!projectMembers.has(userId)) {
                return res.status(403).json({ message: 'You must be a member of the project to create a chat group' });
            }
            const isOwner = ownerIds.has(userId);
            hasPermission = isAdmin || isOwner;
            if (!hasPermission) {
                const permission = await models_1.ProjectPermission.findOne({ projectId, userId });
                hasPermission = !!permission?.permissions?.canCreateChatGroups;
            }
            if (!hasPermission) {
                return res.status(403).json({ message: 'You do not have permission to create chat groups for this project' });
            }
        }
        else {
            hasPermission = true;
        }
        const allMemberIds = [...new Set([userId, ...(Array.isArray(memberIds) ? memberIds : [])].map(id => id.toString()))];
        if (projectId && projectMembers.size > 0) {
            const invalidMember = allMemberIds.find(id => !projectMembers.has(id));
            if (invalidMember) {
                return res.status(400).json({ message: 'All members must belong to the selected project' });
            }
        }
        const members = await User_1.User.find({
            _id: { $in: allMemberIds },
            isActive: true
        });
        if (members.length !== allMemberIds.length) {
            return res.status(400).json({ message: 'One or more users not found or inactive' });
        }
        const chatGroup = await ChatGroup_1.ChatGroup.create({
            name,
            description: description || '',
            createdBy: req.user._id,
            members: allMemberIds,
            projectId,
            encryptionPublicKey,
            isActive: true
        });
        await chatGroup.populate('members', 'displayName email photoURL');
        await chatGroup.populate('createdBy', 'displayName email');
        allMemberIds.forEach((memberId) => {
            server_1.io.to(`user:${memberId}`).emit('chat:group:created', chatGroup);
        });
        if (projectId) {
            try {
                await AuditLog_1.AuditLog.logAction({
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
            }
            catch (auditErr) {
                console.error('Failed to log chat group creation audit event:', auditErr);
            }
        }
        return res.status(201).json(chatGroup);
    }
    catch (error) {
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
exports.createChatGroup = createChatGroup;
const getUserChatGroups = async (req, res) => {
    try {
        const userId = req.user?._id;
        const chatGroups = await ChatGroup_1.ChatGroup.find({
            members: userId,
            isActive: true
        })
            .populate('members', 'displayName email photoURL')
            .populate('createdBy', 'displayName email')
            .sort({ updatedAt: -1 });
        const groupsWithMetadata = await Promise.all(chatGroups.map(async (group) => {
            const lastMessage = await Message_1.Message.findOne({
                groupId: group._id,
                isDeleted: false
            })
                .populate('senderId', 'displayName email photoURL')
                .sort({ createdAt: -1 })
                .lean();
            const unreadCount = await Message_1.Message.countDocuments({
                groupId: group._id,
                isDeleted: false,
                'readBy.userId': { $ne: userId }
            });
            return {
                ...group.toObject(),
                unreadCount,
                lastMessage: lastMessage || null
            };
        }));
        groupsWithMetadata.sort((a, b) => {
            const aTime = a.lastMessage?.createdAt || a.updatedAt;
            const bTime = b.lastMessage?.createdAt || b.updatedAt;
            return new Date(bTime).getTime() - new Date(aTime).getTime();
        });
        return res.json(groupsWithMetadata);
    }
    catch (error) {
        console.error('Error fetching chat groups:', error);
        return res.status(500).json({ message: 'Failed to fetch chat groups' });
    }
};
exports.getUserChatGroups = getUserChatGroups;
const getChatGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user?._id;
        const chatGroup = await ChatGroup_1.ChatGroup.findOne({
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
    }
    catch (error) {
        console.error('Error fetching chat group:', error);
        return res.status(500).json({ message: 'Failed to fetch chat group' });
    }
};
exports.getChatGroup = getChatGroup;
const sendMessage = async (req, res) => {
    try {
        const { groupId, encryptedContent, nonce, attachments, replyTo } = req.body;
        const senderId = req.user?._id;
        const chatGroup = await ChatGroup_1.ChatGroup.findOne({
            _id: groupId,
            members: senderId,
            isActive: true
        });
        if (!chatGroup) {
            return res.status(403).json({ message: 'Not authorized to send messages to this group' });
        }
        let replyToMessage = null;
        if (replyTo && mongoose_1.default.Types.ObjectId.isValid(replyTo)) {
            replyToMessage = await Message_1.Message.findById(replyTo);
            if (!replyToMessage || replyToMessage.groupId.toString() !== groupId) {
                replyToMessage = null;
            }
        }
        const message = await Message_1.Message.create({
            groupId,
            senderId,
            encryptedContent,
            nonce,
            attachments: attachments || [],
            replyTo: replyToMessage?._id,
            readBy: [{ userId: senderId, readAt: new Date() }]
        });
        await message.populate('senderId', 'displayName email photoURL');
        if (message.replyTo) {
            await message.populate({
                path: 'replyTo',
                select: 'senderId encryptedContent nonce attachments isDeleted createdAt',
                populate: { path: 'senderId', select: 'displayName email photoURL' }
            });
        }
        chatGroup.updatedAt = new Date();
        await chatGroup.save();
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:message:new', {
                groupId,
                message
            });
        });
        return res.status(201).json(message);
    }
    catch (error) {
        console.error('Error sending message:', error);
        return res.status(500).json({ message: 'Failed to send message' });
    }
};
exports.sendMessage = sendMessage;
const getGroupMessages = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user?._id;
        const limit = parseInt(req.query.limit) || 50;
        const skip = parseInt(req.query.skip) || 0;
        const chatGroup = await ChatGroup_1.ChatGroup.findOne({
            _id: groupId,
            members: userId,
            isActive: true
        });
        if (!chatGroup) {
            return res.status(403).json({ message: 'Not authorized to view messages in this group' });
        }
        const messages = await Message_1.Message.find({
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
        const totalCount = await Message_1.Message.countDocuments({
            groupId,
            isDeleted: false
        });
        return res.json({
            messages: messages.reverse(),
            totalCount,
            hasMore: skip + limit < totalCount
        });
    }
    catch (error) {
        console.error('Error fetching messages:', error);
        return res.status(500).json({ message: 'Failed to fetch messages' });
    }
};
exports.getGroupMessages = getGroupMessages;
const markMessageAsRead = async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user?._id;
        const message = await Message_1.Message.findById(messageId);
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        const alreadyRead = message.readBy.some((read) => read.userId.toString() === userId?.toString());
        if (!alreadyRead) {
            message.readBy.push({ userId: userId, readAt: new Date() });
            await message.save();
            server_1.io.to(`user:${message.senderId.toString()}`).emit('chat:message:read', {
                messageId,
                userId,
                groupId: message.groupId
            });
        }
        return res.json({ success: true });
    }
    catch (error) {
        console.error('Error marking message as read:', error);
        return res.status(500).json({ message: 'Failed to mark message as read' });
    }
};
exports.markMessageAsRead = markMessageAsRead;
const editMessage = async (req, res) => {
    try {
        const { messageId } = req.params;
        const { encryptedContent, nonce } = req.body;
        const userId = req.user?._id;
        const message = await Message_1.Message.findById(messageId);
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        if (message.senderId.toString() !== userId?.toString()) {
            return res.status(403).json({ message: 'You can only edit your own messages' });
        }
        if (message.isDeleted) {
            return res.status(400).json({ message: 'Cannot edit a deleted message' });
        }
        message.encryptedContent = encryptedContent;
        message.nonce = nonce;
        await message.save();
        await message.populate('senderId', 'displayName email photoURL');
        const chatGroup = await ChatGroup_1.ChatGroup.findById(message.groupId);
        if (chatGroup) {
            chatGroup.members.forEach((memberId) => {
                server_1.io.to(`user:${memberId.toString()}`).emit('chat:message:updated', {
                    groupId: message.groupId,
                    message
                });
            });
        }
        return res.json(message);
    }
    catch (error) {
        console.error('Error editing message:', error);
        return res.status(500).json({ message: 'Failed to edit message' });
    }
};
exports.editMessage = editMessage;
const deleteMessage = async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user?._id;
        const message = await Message_1.Message.findById(messageId);
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        const isSender = message.senderId.toString() === userId?.toString();
        if (!isSender) {
            return res.status(403).json({ message: 'You can only delete your own messages' });
        }
        const chatGroup = await ChatGroup_1.ChatGroup.findById(message.groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        message.isDeleted = true;
        await message.save();
        await message.populate('senderId', 'displayName email photoURL');
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:message:deleted', {
                groupId: message.groupId,
                message
            });
        });
        return res.json({ success: true, message });
    }
    catch (error) {
        console.error('Error deleting message:', error);
        return res.status(500).json({ message: 'Failed to delete message' });
    }
};
exports.deleteMessage = deleteMessage;
const addMembersToGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const { memberIds } = req.body;
        const chatGroup = await ChatGroup_1.ChatGroup.findById(groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        const isAdmin = req.user?.role === 'admin';
        const isCreator = chatGroup.createdBy.toString() === req.user?._id;
        if (!isAdmin && !isCreator) {
            return res.status(403).json({ message: 'Only admins or group creator can add members' });
        }
        const members = await User_1.User.find({
            _id: { $in: memberIds },
            isActive: true
        });
        if (members.length !== memberIds.length) {
            return res.status(400).json({ message: 'One or more users not found or inactive' });
        }
        const newMemberIds = memberIds.filter((id) => !chatGroup.members.some((m) => m.toString() === id));
        chatGroup.members.push(...newMemberIds);
        await chatGroup.save();
        await chatGroup.populate('members', 'displayName email photoURL');
        await chatGroup.populate('createdBy', 'displayName email photoURL');
        newMemberIds.forEach((memberId) => {
            server_1.io.to(`user:${memberId}`).emit('chat:group:added', chatGroup);
        });
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
        });
        return res.json(chatGroup);
    }
    catch (error) {
        console.error('Error adding members:', error);
        return res.status(500).json({ message: 'Failed to add members' });
    }
};
exports.addMembersToGroup = addMembersToGroup;
const removeMemberFromGroup = async (req, res) => {
    try {
        const { groupId, userId } = req.params;
        const chatGroup = await ChatGroup_1.ChatGroup.findById(groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        const isAdmin = req.user?.role === 'admin';
        const isCreator = chatGroup.createdBy.toString() === req.user?._id;
        if (!isAdmin && !isCreator) {
            return res.status(403).json({ message: 'Only admins or group creator can remove members' });
        }
        chatGroup.members = chatGroup.members.filter((m) => m.toString() !== userId);
        await chatGroup.save();
        await chatGroup.populate('members', 'displayName email photoURL');
        await chatGroup.populate('createdBy', 'displayName email photoURL');
        server_1.io.to(`user:${userId}`).emit('chat:group:removed', { groupId });
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
        });
        return res.json(chatGroup);
    }
    catch (error) {
        console.error('Error removing member:', error);
        return res.status(500).json({ message: 'Failed to remove member' });
    }
};
exports.removeMemberFromGroup = removeMemberFromGroup;
const updateChatGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const { name, description } = req.body;
        const chatGroup = await ChatGroup_1.ChatGroup.findById(groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        const isAdmin = req.user?.role === 'admin';
        const isCreator = chatGroup.createdBy.toString() === req.user?._id;
        if (!isAdmin && !isCreator) {
            return res.status(403).json({ message: 'Only admins or group creator can update chat groups' });
        }
        if (name !== undefined)
            chatGroup.name = name;
        if (description !== undefined)
            chatGroup.description = description;
        await chatGroup.save();
        await chatGroup.populate('members', 'displayName email photoURL');
        await chatGroup.populate('createdBy', 'displayName email');
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:group:updated', chatGroup);
        });
        return res.json(chatGroup);
    }
    catch (error) {
        console.error('Error updating chat group:', error);
        return res.status(500).json({ message: 'Failed to update chat group' });
    }
};
exports.updateChatGroup = updateChatGroup;
const deleteChatGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user?._id?.toString();
        const chatGroup = await ChatGroup_1.ChatGroup.findById(groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        const isAdmin = req.user?.role === 'admin';
        const isCreator = chatGroup.createdBy.toString() === userId;
        let project = null;
        let canDelete = isAdmin;
        if (chatGroup.projectId) {
            project = await models_1.Project.findById(chatGroup.projectId);
            if (project) {
                const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
                    ? project.ownerId._id.toString()
                    : project.ownerId.toString();
                const ownerIds = new Set([
                    ownerId,
                    ...(project.owners || []).map((o) => (typeof o === 'object' && o._id ? o._id.toString() : o.toString()))
                ]);
                const isOwner = userId ? ownerIds.has(userId) : false;
                if (isOwner) {
                    canDelete = true;
                }
                else if (isCreator && userId) {
                    const permission = await models_1.ProjectPermission.findOne({ projectId: chatGroup.projectId, userId });
                    canDelete = !!permission?.permissions?.canDeleteChatGroups;
                }
            }
        }
        else if (isCreator) {
            canDelete = true;
        }
        if (!canDelete) {
            return res.status(403).json({ message: 'You do not have permission to delete this chat group' });
        }
        chatGroup.isActive = false;
        await chatGroup.save();
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:group:deleted', { groupId });
        });
        if (chatGroup.projectId) {
            try {
                await AuditLog_1.AuditLog.logAction({
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
            }
            catch (auditErr) {
                console.error('Failed to log chat group deletion audit event:', auditErr);
            }
        }
        return res.json({ message: 'Chat group deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting chat group:', error);
        return res.status(500).json({ message: 'Failed to delete chat group' });
    }
};
exports.deleteChatGroup = deleteChatGroup;
//# sourceMappingURL=chatController.js.map