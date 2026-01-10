"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAuditLogs = void 0;
const AuditLog_1 = require("../models/AuditLog");
const actionToEventMap = {
    'task_created': 'task.created',
    'task_updated': 'task.updated',
    'task_deleted': 'task.deleted',
    'task_assigned': 'task.assigned',
    'task_status_changed': 'task.status_changed',
    'task_completed': 'task.completed',
    'member_added': 'member.added',
    'member_removed': 'member.removed',
    'permission_changed': 'permission.changed',
    'project_updated': 'project.updated',
    'time_logged': 'time.logged',
    'comment_added': 'comment.added',
    'chat_group_created': 'chat_group.created',
    'chat_group_deleted': 'chat_group.deleted'
};
const generateDetails = (log) => {
    const metadata = log.metadata || {};
    switch (log.action) {
        case 'task_created':
            return `Created task "${metadata.taskTitle || 'Untitled'}"`;
        case 'task_updated':
            return `Updated task "${metadata.taskTitle || 'Untitled'}"`;
        case 'task_deleted':
            return `Deleted task "${metadata.taskTitle || 'Untitled'}"`;
        case 'task_assigned':
            return `Assigned task "${metadata.taskTitle || 'Untitled'}" to ${metadata.assigneeName || 'user'}`;
        case 'task_status_changed':
            return `Changed task "${metadata.taskTitle || 'Untitled'}" status from "${metadata.oldStatus || 'unknown'}" to "${metadata.newStatus || 'unknown'}"`;
        case 'task_completed':
            return `Completed task "${metadata.taskTitle || 'Untitled'}"`;
        case 'member_added':
            return `Added ${metadata.memberName || 'member'} to project`;
        case 'member_removed':
            return `Removed ${metadata.memberName || 'member'} from project`;
        case 'permission_changed':
            return `Changed permissions for ${metadata.memberName || 'user'}`;
        case 'project_updated':
            if (metadata.actionType === 'created') {
                return `Created project "${metadata.projectName || 'Untitled'}"`;
            }
            else if (metadata.actionType === 'deleted') {
                return `Deleted project "${metadata.projectName || 'Untitled'}"`;
            }
            return `Updated project "${metadata.projectName || 'settings'}"`;
        case 'time_logged':
            return `Logged ${metadata.duration || 0} minutes on task`;
        case 'comment_added':
            return `Added comment to task`;
        case 'chat_group_created':
            return `Created chat group "${metadata.groupName || 'Untitled Group'}"${metadata.projectName ? ` in project "${metadata.projectName}"` : ''}`;
        case 'chat_group_deleted':
            return `Deleted chat group "${metadata.groupName || 'Untitled Group'}"${metadata.projectName ? ` from project "${metadata.projectName}"` : ''}`;
        default:
            return `Performed action: ${log.action}`;
    }
};
const generateMockAuditLogs = (limit = 20) => {
    const events = [
        'task.created',
        'task.updated',
        'task.deleted',
        'task.assigned',
        'task.completed',
        'project.created',
        'project.updated',
        'project.deleted',
        'user.login',
        'user.logout',
        'user.registered',
        'user.role_changed',
        'permission.granted',
        'permission.revoked',
        'member.added',
        'member.removed',
    ];
    const resources = [
        'Task #1234',
        'Task #5678',
        'Task #9012',
        'Project: Website Redesign',
        'Project: Mobile App',
        'Project: Marketing Campaign',
        'User: john.doe@example.com',
        'User: jane.smith@example.com',
        'Permission Set: Project Manager',
    ];
    const users = [
        { id: '1', name: 'John Doe', email: 'john.doe@example.com' },
        { id: '2', name: 'Jane Smith', email: 'jane.smith@example.com' },
        { id: '3', name: 'Bob Johnson', email: 'bob.johnson@example.com' },
        { id: '4', name: 'Alice Williams', email: 'alice.williams@example.com' },
        { id: '5', name: 'Charlie Brown', email: 'charlie.brown@example.com' },
    ];
    const sources = ['Web App', 'Mobile App', 'API', 'System', 'Integration'];
    const auditLogs = [];
    for (let i = 0; i < limit; i++) {
        const event = events[Math.floor(Math.random() * events.length)];
        const user = users[Math.floor(Math.random() * users.length)];
        const resource = resources[Math.floor(Math.random() * resources.length)];
        const source = sources[Math.floor(Math.random() * sources.length)];
        const timestamp = new Date(Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000)).toISOString();
        let details = '';
        let metadata = {};
        switch (event) {
            case 'task.created':
                details = `Created task "${resource}" in project`;
                metadata = {
                    payload: {
                        taskId: `task_${i}`,
                        title: resource,
                        status: 'todo',
                        priority: 'medium',
                    },
                };
                break;
            case 'task.updated':
                details = `Updated task "${resource}" status from "In Progress" to "Completed"`;
                metadata = {
                    before: { status: 'in_progress', priority: 'medium' },
                    after: { status: 'completed', priority: 'medium' },
                    payload: {
                        taskId: `task_${i}`,
                        changes: ['status'],
                    },
                };
                break;
            case 'task.deleted':
                details = `Deleted task "${resource}"`;
                metadata = {
                    before: {
                        taskId: `task_${i}`,
                        title: resource,
                        status: 'todo',
                    },
                    payload: {
                        taskId: `task_${i}`,
                        reason: 'duplicate',
                    },
                };
                break;
            case 'task.assigned':
                details = `Assigned task "${resource}" to ${user.name}`;
                metadata = {
                    before: { assignee: null },
                    after: { assignee: user.email },
                    payload: {
                        taskId: `task_${i}`,
                        assigneeId: user.id,
                    },
                };
                break;
            case 'task.completed':
                details = `Marked task "${resource}" as completed`;
                metadata = {
                    before: { status: 'in_progress', completedAt: null },
                    after: { status: 'completed', completedAt: new Date().toISOString() },
                    payload: {
                        taskId: `task_${i}`,
                        completionTime: '2 hours',
                    },
                };
                break;
            case 'project.created':
                details = `Created project "${resource}"`;
                metadata = {
                    payload: {
                        projectId: `proj_${i}`,
                        name: resource,
                        members: [user.email],
                        status: 'active',
                    },
                };
                break;
            case 'project.updated':
                details = `Updated project "${resource}" settings`;
                metadata = {
                    before: { status: 'active', description: 'Old description' },
                    after: { status: 'active', description: 'Updated project description' },
                    payload: {
                        projectId: `proj_${i}`,
                        changes: ['description'],
                    },
                };
                break;
            case 'project.deleted':
                details = `Deleted project "${resource}"`;
                metadata = {
                    before: {
                        projectId: `proj_${i}`,
                        name: resource,
                        status: 'archived',
                    },
                };
                break;
            case 'user.login':
                details = `User logged in from ${source}`;
                metadata = {
                    payload: {
                        userId: user.id,
                        ipAddress: `192.168.1.${Math.floor(Math.random() * 255)}`,
                        userAgent: 'Mozilla/5.0...',
                    },
                };
                break;
            case 'user.logout':
                details = `User logged out`;
                metadata = {
                    payload: {
                        userId: user.id,
                        sessionDuration: '2h 45m',
                    },
                };
                break;
            case 'user.registered':
                details = `New user registered: ${user.email}`;
                metadata = {
                    payload: {
                        userId: user.id,
                        email: user.email,
                        registrationMethod: 'email',
                    },
                };
                break;
            case 'user.role_changed':
                details = `Changed user role from "member" to "manager"`;
                metadata = {
                    before: { role: 'member', permissions: ['read', 'create'] },
                    after: { role: 'manager', permissions: ['read', 'create', 'update', 'delete', 'manage'] },
                    payload: {
                        userId: user.id,
                        changedBy: users[0].id,
                    },
                };
                break;
            case 'permission.granted':
                details = `Granted ${resource} permissions to ${user.name}`;
                metadata = {
                    after: { permissions: ['read', 'write', 'delete'] },
                    payload: {
                        userId: user.id,
                        resourceType: 'project',
                        resourceId: `proj_${i}`,
                    },
                };
                break;
            case 'permission.revoked':
                details = `Revoked ${resource} permissions from ${user.name}`;
                metadata = {
                    before: { permissions: ['read', 'write', 'delete'] },
                    after: { permissions: ['read'] },
                    payload: {
                        userId: user.id,
                        resourceType: 'project',
                        resourceId: `proj_${i}`,
                    },
                };
                break;
            case 'member.added':
                details = `Added ${user.name} to ${resource}`;
                metadata = {
                    after: { members: [user.email], role: 'member' },
                    payload: {
                        userId: user.id,
                        projectId: `proj_${i}`,
                        invitedBy: users[0].id,
                    },
                };
                break;
            case 'member.removed':
                details = `Removed ${user.name} from ${resource}`;
                metadata = {
                    before: { members: [user.email], role: 'member' },
                    payload: {
                        userId: user.id,
                        projectId: `proj_${i}`,
                        removedBy: users[0].id,
                    },
                };
                break;
            default:
                details = `Performed action: ${event}`;
                metadata = { payload: { eventType: event } };
        }
        auditLogs.push({
            id: `audit_${Date.now()}_${i}`,
            timestamp,
            user,
            event,
            resource,
            details,
            source,
            metadata,
        });
    }
    return auditLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
};
const getAuditLogs = async (req, res) => {
    try {
        console.log('Audit logs endpoint called');
        console.log('Query params:', req.query);
        console.log('User:', req.user);
        const { limit = '50', startDate, endDate, eventType, userId, search, projectId, } = req.query;
        const parsedLimit = Math.min(parseInt(limit, 10) || 50, 10000);
        console.log('Fetching audit logs with limit:', parsedLimit);
        const query = {};
        if (projectId) {
            query.projectId = projectId;
        }
        if (userId) {
            query.userId = userId;
        }
        if (eventType) {
            const action = eventType.replace('.', '_');
            query.action = action;
        }
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) {
                query.createdAt.$gte = new Date(startDate);
            }
            if (endDate) {
                query.createdAt.$lte = new Date(endDate);
            }
        }
        console.log('Query:', JSON.stringify(query));
        let auditLogs = await AuditLog_1.AuditLog.find(query)
            .populate('userId', 'displayName email photoURL')
            .populate('projectId', 'name')
            .sort({ createdAt: -1 })
            .limit(parsedLimit)
            .lean();
        console.log('Found audit logs:', auditLogs.length);
        let transformedLogs = auditLogs.map((log) => {
            const user = log.userId || {};
            const project = log.projectId || {};
            return {
                id: log._id.toString(),
                timestamp: log.createdAt,
                user: {
                    id: user._id?.toString() || 'unknown',
                    name: user.displayName || user.email || 'Unknown User',
                    email: user.email || 'unknown@email.com',
                },
                event: actionToEventMap[log.action] || log.action,
                resource: log.metadata?.taskTitle || project.name || log.entityType || 'Unknown Resource',
                details: generateDetails(log),
                source: 'Web App',
                metadata: {
                    before: log.metadata?.oldValue ? { value: log.metadata.oldValue } : undefined,
                    after: log.metadata?.newValue ? { value: log.metadata.newValue } : undefined,
                    payload: {
                        action: log.action,
                        entityType: log.entityType,
                        entityId: log.entityId?.toString(),
                        projectId: log.projectId?._id?.toString() || log.projectId,
                        ...log.metadata,
                    },
                },
            };
        });
        if (search) {
            const searchLower = search.toLowerCase();
            transformedLogs = transformedLogs.filter((log) => log.event.toLowerCase().includes(searchLower) ||
                log.resource.toLowerCase().includes(searchLower) ||
                log.details.toLowerCase().includes(searchLower) ||
                log.user.name.toLowerCase().includes(searchLower) ||
                log.user.email.toLowerCase().includes(searchLower));
        }
        console.log('Returning audit logs, count:', transformedLogs.length);
        return res.status(200).json({
            success: true,
            message: 'Audit logs retrieved successfully',
            data: transformedLogs,
            meta: {
                total: transformedLogs.length,
                limit: parsedLimit,
                filters: {
                    startDate,
                    endDate,
                    eventType,
                    userId,
                    search,
                    projectId,
                },
            },
        });
    }
    catch (error) {
        console.error('Error fetching audit logs:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve audit logs',
            error: error.message,
        });
    }
};
exports.getAuditLogs = getAuditLogs;
//# sourceMappingURL=auditController.js.map