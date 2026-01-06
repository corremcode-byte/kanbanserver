"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteChatGroup = exports.updateChatGroup = exports.removeMemberFromGroup = exports.addMembersToGroup = exports.markMessageAsRead = exports.getGroupMessages = exports.sendMessage = exports.getChatGroup = exports.getUserChatGroups = exports.createChatGroup = void 0;
const ChatGroup_1 = require("../models/ChatGroup");
const Message_1 = require("../models/Message");
const User_1 = require("../models/User");
const server_1 = require("../server");
const createChatGroup = async (req, res) => {
    try {
        const { name, description, memberIds, encryptionPublicKey } = req.body;
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can create chat groups' });
        }
        const allMemberIds = [...new Set([req.user._id.toString(), ...memberIds])];
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
            encryptionPublicKey,
            isActive: true
        });
        await chatGroup.populate('members', 'displayName email photoURL');
        await chatGroup.populate('createdBy', 'displayName email');
        allMemberIds.forEach((memberId) => {
            server_1.io.to(`user:${memberId}`).emit('chat:group:created', chatGroup);
        });
        return res.status(201).json(chatGroup);
    }
    catch (error) {
        console.error('Error creating chat group:', error);
        return res.status(500).json({ message: 'Failed to create chat group' });
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
        return res.json(chatGroups);
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
        const { groupId, encryptedContent, nonce, attachments } = req.body;
        const senderId = req.user?._id;
        const chatGroup = await ChatGroup_1.ChatGroup.findOne({
            _id: groupId,
            members: senderId,
            isActive: true
        });
        if (!chatGroup) {
            return res.status(403).json({ message: 'Not authorized to send messages to this group' });
        }
        const message = await Message_1.Message.create({
            groupId,
            senderId,
            encryptedContent,
            nonce,
            attachments: attachments || [],
            readBy: [{ userId: senderId, readAt: new Date() }]
        });
        await message.populate('senderId', 'displayName email photoURL');
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
        const chatGroup = await ChatGroup_1.ChatGroup.findById(groupId);
        if (!chatGroup) {
            return res.status(404).json({ message: 'Chat group not found' });
        }
        const isAdmin = req.user?.role === 'admin';
        const isCreator = chatGroup.createdBy.toString() === req.user?._id;
        if (!isAdmin && !isCreator) {
            return res.status(403).json({ message: 'Only admins or group creator can delete chat groups' });
        }
        chatGroup.isActive = false;
        await chatGroup.save();
        chatGroup.members.forEach((memberId) => {
            server_1.io.to(`user:${memberId.toString()}`).emit('chat:group:deleted', { groupId });
        });
        return res.json({ message: 'Chat group deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting chat group:', error);
        return res.status(500).json({ message: 'Failed to delete chat group' });
    }
};
exports.deleteChatGroup = deleteChatGroup;
//# sourceMappingURL=chatController.js.map