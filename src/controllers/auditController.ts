import { Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { User } from '../models/User';

/**
 * Audit Controller
 * Handles audit log retrieval - fetches real data from the database
 */

// Map action names to user-friendly event names
const actionToEventMap: Record<string, string> = {
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

// Generate user-friendly details from audit log entry
const generateDetails = (log: any): string => {
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
      // Check for special action types
      if (metadata.actionType === 'created') {
        return `Created project "${metadata.projectName || 'Untitled'}"`;
      } else if (metadata.actionType === 'deleted') {
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

// Legacy mock data generator (keeping for backward compatibility)
const generateMockAuditLogs = (limit: number = 20): any[] => {
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

    // Generate timestamp within the last 30 days
    const timestamp = new Date(
      Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000)
    ).toISOString();

    // Generate event-specific details
    let details = '';
    let metadata: any = {};

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

  // Sort by timestamp descending (most recent first)
  return auditLogs.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
};

/**
 * GET /api/audit
 * Retrieves audit logs with optional filtering
 *
 * Query Parameters:
 * - limit: Number of records to return (default: 50, max: 10000)
 * - startDate: Filter events after this date (ISO 8601)
 * - endDate: Filter events before this date (ISO 8601)
 * - eventType: Filter by specific event type
 * - userId: Filter by user ID
 * - search: Search across event, resource, and details fields
 *
 * Access: admin, manager only (enforced by middleware)
 */
export const getAuditLogs = async (req: any, res: Response) => {
  try {
    console.log('Audit logs endpoint called');
    console.log('Query params:', req.query);
    console.log('User:', req.user);

    // Extract query parameters
    const {
      limit = '50',
      startDate,
      endDate,
      eventType,
      userId,
      search,
      projectId,
    } = req.query;

    // Validate and parse limit - allow up to 10000 records to show all logs
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 50, 10000);
    console.log('Fetching audit logs with limit:', parsedLimit);

    // Build query
    const query: any = {};

    // Filter by project if specified
    if (projectId) {
      query.projectId = projectId;
    }

    // Filter by user if specified
    if (userId) {
      query.userId = userId;
    }

    // Filter by action/event type if specified
    if (eventType) {
      // Convert event type back to action (e.g., 'task.created' -> 'task_created')
      const action = eventType.replace('.', '_');
      query.action = action;
    }

    // Date range filtering
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate as string);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate as string);
      }
    }

    console.log('Query:', JSON.stringify(query));

    // Fetch audit logs from database
    let auditLogs = await AuditLog.find(query)
      .populate('userId', 'displayName email photoURL isActive')
      .populate('projectId', 'name')
      .sort({ createdAt: -1 })
      .limit(parsedLimit * 2) // Get more to filter out inactive users
      .lean();

    // Filter out logs for deleted or inactive users
    const activeLogs: any[] = [];
    
    for (const log of auditLogs) {
      if (log.userId) {
        const userId = typeof log.userId === 'object' && (log.userId as any)._id 
          ? (log.userId as any)._id.toString() 
          : log.userId.toString();
        
        // Check if user exists and is active
        const user = await User.findById(userId).select('isActive').lean();
        if (user && user.isActive !== false) {
          activeLogs.push(log);
          if (activeLogs.length >= parsedLimit) {
            break;
          }
        }
      }
    }
    
    auditLogs = activeLogs;

    console.log('Found audit logs:', auditLogs.length);

    // Transform audit logs to frontend format
    let transformedLogs = auditLogs.map((log: any) => {
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
        source: 'Web App', // Default to Web App for now
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

    // Apply search filter if provided (client-side search on transformed data)
    if (search) {
      const searchLower = (search as string).toLowerCase();
      transformedLogs = transformedLogs.filter(
        (log: any) =>
          log.event.toLowerCase().includes(searchLower) ||
          log.resource.toLowerCase().includes(searchLower) ||
          log.details.toLowerCase().includes(searchLower) ||
          log.user.name.toLowerCase().includes(searchLower) ||
          log.user.email.toLowerCase().includes(searchLower)
      );
    }

    // Return audit logs
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
  } catch (error: any) {
    console.error('Error fetching audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve audit logs',
      error: error.message,
    });
  }
};

/**
 * DELETE /api/audit
 * Deletes all audit logs
 *
 * Access: admin only (enforced by middleware)
 */
export const deleteAllAuditLogs = async (req: any, res: Response) => {
  try {
    console.log('Delete all audit logs endpoint called by user:', req.user?.email);

    // Delete all audit logs
    const result = await AuditLog.deleteMany({});

    console.log(`Deleted ${result.deletedCount} audit logs`);

    return res.status(200).json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} audit logs`,
      data: {
        deletedCount: result.deletedCount
      }
    });
  } catch (error: any) {
    console.error('Error deleting audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete audit logs',
      error: error.message,
    });
  }
};

/**
 * POST /api/audit/cleanup
 * Cleanup audit logs for deleted or inactive users
 *
 * Access: admin only (enforced by middleware)
 */
export const cleanupDeletedUsers = async (req: any, res: Response) => {
  try {
    console.log('Cleanup audit logs for deleted users endpoint called by user:', req.user?.email);

    // Run cleanup
    const result = await AuditLog.cleanupDeletedUsers();

    console.log(`Cleaned up ${result.deletedCount} audit logs for deleted/inactive users`);

    return res.status(200).json({
      success: true,
      message: `Successfully cleaned up ${result.deletedCount} audit logs for deleted or inactive users`,
      data: {
        deletedCount: result.deletedCount
      }
    });
  } catch (error: any) {
    console.error('Error cleaning up audit logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to cleanup audit logs',
      error: error.message,
    });
  }
};
