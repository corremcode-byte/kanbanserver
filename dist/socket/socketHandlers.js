"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastToProject = exports.broadcastToUser = exports.getUserPresence = exports.getActiveUserConnections = exports.setupSocketHandlers = void 0;
const socketAuth_1 = require("./socketAuth");
const logger_1 = require("../utils/logger");
const activeConnections = new Map();
const socketRooms = new Map();
const addUserConnection = (userId, socketId) => {
    if (!activeConnections.has(userId)) {
        activeConnections.set(userId, new Set());
    }
    activeConnections.get(userId).add(socketId);
};
const removeUserConnection = (userId, socketId) => {
    const userSockets = activeConnections.get(userId);
    if (userSockets) {
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
            activeConnections.delete(userId);
        }
    }
};
const addSocketRoom = (socketId, room) => {
    if (!socketRooms.has(socketId)) {
        socketRooms.set(socketId, new Set());
    }
    socketRooms.get(socketId).add(room);
};
const removeSocketRoom = (socketId, room) => {
    const rooms = socketRooms.get(socketId);
    if (rooms) {
        rooms.delete(room);
    }
};
const cleanupSocket = (socketId) => {
    socketRooms.delete(socketId);
};
const setupSocketHandlers = (io) => {
    io.on('connection', (socket) => {
        const userId = (0, socketAuth_1.getSocketUserId)(socket);
        if (!userId) {
            logger_1.logger.error('Socket connected without user ID');
            socket.disconnect();
            return;
        }
        const connectionInfo = {
            socketId: socket.id,
            userId,
            userName: socket.user?.name || 'Unknown',
            userEmail: socket.user?.email || 'Unknown',
            timestamp: new Date().toISOString(),
            clientAddress: socket.handshake.address,
            userAgent: socket.handshake.headers['user-agent'] || 'Unknown'
        };
        logger_1.logger.info('✅ Frontend connected:', connectionInfo);
        addUserConnection(userId, socket.id);
        const userRoom = `user:${userId}`;
        socket.join(userRoom);
        addSocketRoom(socket.id, userRoom);
        logger_1.logger.info(`User ${socket.user?.name || userId} joined room: ${userRoom}`);
        socket.on('join:project', async (projectId) => {
            try {
                if (!projectId || typeof projectId !== 'string') {
                    socket.emit('error', { message: 'Invalid project ID' });
                    return;
                }
                const canJoin = await (0, socketAuth_1.canJoinRoom)(socket, 'project', projectId);
                if (!canJoin) {
                    socket.emit('error', { message: 'Access denied to project' });
                    return;
                }
                const room = `project:${projectId}`;
                socket.join(room);
                addSocketRoom(socket.id, room);
                socket.emit('joined:project', { projectId });
                logger_1.logger.info(`✅ User ${socket.user?.name || userId} (${socket.id}) joined project room: ${room}`);
            }
            catch (error) {
                logger_1.logger.error('Error joining project room:', error);
                socket.emit('error', { message: 'Failed to join project' });
            }
        });
        socket.on('leave:project', (projectId) => {
            try {
                if (!projectId || typeof projectId !== 'string') {
                    socket.emit('error', { message: 'Invalid project ID' });
                    return;
                }
                const room = `project:${projectId}`;
                socket.leave(room);
                removeSocketRoom(socket.id, room);
                socket.emit('left:project', { projectId });
                logger_1.logger.info(`User ${socket.user?.name || userId} (${socket.id}) left project room: ${room}`);
            }
            catch (error) {
                logger_1.logger.error('Error leaving project room:', error);
            }
        });
        socket.on('task:update', (data) => {
            try {
                const { projectId, taskId, task } = data;
                if (!projectId || !taskId || !task) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('task:updated', {
                    taskId,
                    task,
                    updatedBy: userId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling task update:', error);
            }
        });
        socket.on('task:create', (data) => {
            try {
                const { projectId, task } = data;
                if (!projectId || !task) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('task:created', {
                    task,
                    createdBy: userId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling task creation:', error);
            }
        });
        socket.on('task:delete', (data) => {
            try {
                const { projectId, taskId } = data;
                if (!projectId || !taskId) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('task:deleted', {
                    taskId,
                    deletedBy: userId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling task deletion:', error);
            }
        });
        socket.on('tasks:reorder', (data) => {
            try {
                const { projectId, tasks } = data;
                if (!projectId || !tasks) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('tasks:reordered', {
                    projectId,
                    tasks,
                    reorderedBy: userId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling tasks reordering:', error);
            }
        });
        socket.on('typing:start', (data) => {
            try {
                const { projectId, taskId } = data;
                if (!projectId) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('typing:start', {
                    userId,
                    user: {
                        id: socket.user._id,
                        name: socket.user.name,
                        avatar: socket.user.avatar
                    },
                    projectId,
                    taskId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling typing start:', error);
            }
        });
        socket.on('typing:stop', (data) => {
            try {
                const { projectId, taskId } = data;
                if (!projectId) {
                    return;
                }
                const room = `project:${projectId}`;
                socket.to(room).emit('typing:stop', {
                    userId,
                    projectId,
                    taskId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling typing stop:', error);
            }
        });
        socket.on('join:chat', async (groupId) => {
            try {
                if (!groupId || typeof groupId !== 'string') {
                    socket.emit('error', { message: 'Invalid group ID' });
                    return;
                }
                const room = `chat:${groupId}`;
                socket.join(room);
                addSocketRoom(socket.id, room);
                socket.emit('joined:chat', { groupId });
                logger_1.logger.info(`✅ User ${socket.user?.name || userId} (${socket.id}) joined chat room: ${room}`);
            }
            catch (error) {
                logger_1.logger.error('Error joining chat room:', error);
                socket.emit('error', { message: 'Failed to join chat' });
            }
        });
        socket.on('leave:chat', (groupId) => {
            try {
                if (!groupId || typeof groupId !== 'string') {
                    socket.emit('error', { message: 'Invalid group ID' });
                    return;
                }
                const room = `chat:${groupId}`;
                socket.leave(room);
                removeSocketRoom(socket.id, room);
                socket.emit('left:chat', { groupId });
                logger_1.logger.info(`User ${socket.user?.name || userId} (${socket.id}) left chat room: ${room}`);
            }
            catch (error) {
                logger_1.logger.error('Error leaving chat room:', error);
            }
        });
        socket.on('chat:typing:start', (data) => {
            try {
                const { groupId } = data;
                if (!groupId) {
                    return;
                }
                const room = `chat:${groupId}`;
                socket.to(room).emit('chat:typing:start', {
                    userId,
                    user: {
                        id: socket.user._id,
                        name: socket.user.name,
                        avatar: socket.user.avatar
                    },
                    groupId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling chat typing start:', error);
            }
        });
        socket.on('chat:typing:stop', (data) => {
            try {
                const { groupId } = data;
                if (!groupId) {
                    return;
                }
                const room = `chat:${groupId}`;
                socket.to(room).emit('chat:typing:stop', {
                    userId,
                    groupId,
                    timestamp: new Date()
                });
            }
            catch (error) {
                logger_1.logger.error('Error handling chat typing stop:', error);
            }
        });
        socket.on('disconnect', (reason) => {
            const disconnectionInfo = {
                socketId: socket.id,
                userId,
                userName: socket.user?.name || 'Unknown',
                reason,
                timestamp: new Date().toISOString()
            };
            logger_1.logger.info('❌ Frontend disconnected:', disconnectionInfo);
            removeUserConnection(userId, socket.id);
            cleanupSocket(socket.id);
            const rooms = socketRooms.get(socket.id) || new Set();
            rooms.forEach(room => {
                socket.to(room).emit('user:offline', {
                    userId,
                    timestamp: new Date()
                });
            });
            const remainingConnections = activeConnections.get(userId)?.size || 0;
            logger_1.logger.info(`User ${socket.user?.name || userId} has ${remainingConnections} remaining connection(s)`);
        });
        socket.emit('connected', {
            socketId: socket.id,
            userId,
            timestamp: new Date()
        });
    });
};
exports.setupSocketHandlers = setupSocketHandlers;
const getActiveUserConnections = (userId) => {
    return Array.from(activeConnections.get(userId) || []);
};
exports.getActiveUserConnections = getActiveUserConnections;
const getUserPresence = (userId) => {
    return activeConnections.has(userId) && activeConnections.get(userId).size > 0;
};
exports.getUserPresence = getUserPresence;
const broadcastToUser = (io, userId, event, data) => {
    io.to(`user:${userId}`).emit(event, data);
};
exports.broadcastToUser = broadcastToUser;
const broadcastToProject = (io, projectId, event, data) => {
    io.to(`project:${projectId}`).emit(event, data);
};
exports.broadcastToProject = broadcastToProject;
exports.default = {
    setupSocketHandlers: exports.setupSocketHandlers,
    getActiveUserConnections: exports.getActiveUserConnections,
    getUserPresence: exports.getUserPresence,
    broadcastToUser: exports.broadcastToUser,
    broadcastToProject: exports.broadcastToProject
};
//# sourceMappingURL=socketHandlers.js.map