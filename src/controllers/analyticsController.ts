import { Request, Response } from 'express';
import { AuditLog, Project, Task, User } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    firebaseUid: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

// Get project analytics (owner only)
export const getProjectAnalytics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { startDate, endDate, userId } = req.query;

    // Check if project exists
    const project = await Project.findById(projectId)
      .populate('members', 'displayName email photoURL')
      .populate('managers', 'displayName email photoURL');

    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    if (!isOwner && !isInOwners) {
      return errorResponse(res, 'Only project owners can view analytics', 403);
    }

    // Parse dates
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default to 30 days ago
    const end = endDate ? new Date(endDate as string) : new Date(); // Default to now

    // Get activity logs
    const activityLogs = await AuditLog.getProjectActivity(projectId, {
      userId: userId as string | undefined,
      startDate: start,
      endDate: end,
      limit: 1000
    });

    // Get tasks statistics
    const allTasks = await Task.find({ projectId });
    const completedTasks = allTasks.filter(t => t.status === 'completed' || t.status === 'done');

    // Calculate member statistics
    const memberStats: any[] = [];

    for (const member of project.members) {
      const memberId = typeof member === 'object' && (member as any)._id
        ? (member as any)._id.toString()
        : member.toString();

      const stats = await AuditLog.getUserStats(projectId, memberId, start, end);

      const memberTasks = allTasks.filter(t => {
        const assigneeId = t.assigneeId ? t.assigneeId.toString() : null;
        return assigneeId === memberId;
      });

      const memberCompletedTasks = memberTasks.filter(t => t.status === 'completed' || t.status === 'done');

      memberStats.push({
        userId: memberId,
        user: (member as any).displayName || (member as any).email || 'Unknown',
        email: (member as any).email,
        photoURL: (member as any).photoURL,
        tasksAssigned: memberTasks.length,
        tasksCompleted: memberCompletedTasks.length,
        tasksCreated: stats.tasksCreated,
        tasksUpdated: stats.tasksUpdated,
        totalTimeLogged: stats.totalTimeLogged,
        actionsCount: stats.actionsCount,
        completionRate: memberTasks.length > 0
          ? ((memberCompletedTasks.length / memberTasks.length) * 100).toFixed(2)
          : '0.00'
      });
    }

    // Sort by activity count
    memberStats.sort((a, b) => b.actionsCount - a.actionsCount);

    // Get action distribution
    const actionDistribution: Record<string, number> = {};
    activityLogs.forEach((log: any) => {
      actionDistribution[log.action] = (actionDistribution[log.action] || 0) + 1;
    });

    // Get daily activity for chart
    const dailyActivity: Record<string, number> = {};
    activityLogs.forEach((log: any) => {
      const date = log.createdAt.toISOString().split('T')[0];
      dailyActivity[date] = (dailyActivity[date] || 0) + 1;
    });

    const analytics = {
      project: {
        id: project._id,
        name: project.name,
        totalMembers: project.members.length,
        totalManagers: project.managers ? project.managers.length : 0
      },
      period: {
        startDate: start,
        endDate: end
      },
      summary: {
        totalTasks: allTasks.length,
        completedTasks: completedTasks.length,
        activeTasks: allTasks.filter(t => t.status !== 'completed' && t.status !== 'done').length,
        completionRate: allTasks.length > 0
          ? ((completedTasks.length / allTasks.length) * 100).toFixed(2)
          : '0.00',
        totalActions: activityLogs.length
      },
      memberStats,
      actionDistribution,
      dailyActivity: Object.entries(dailyActivity)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count })),
      recentActivity: activityLogs.slice(0, 50) // Latest 50 actions
    };

    return successResponse(res, 'Analytics retrieved successfully', analytics);
  } catch (error) {
    logger.error('Error getting project analytics:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve analytics');
  }
};

// Get user performance analytics (owner only)
export const getUserAnalytics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, userId } = req.params;
    const { startDate, endDate } = req.query;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    if (!isOwner && !isInOwners) {
      return errorResponse(res, 'Only project owners can view user analytics', 403);
    }

    // Parse dates
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    // Get user statistics
    const stats = await AuditLog.getUserStats(projectId, userId, start, end);

    // Get user activity logs
    const activityLogs = await AuditLog.getProjectActivity(projectId, {
      userId,
      startDate: start,
      endDate: end,
      limit: 100
    });

    // Get user's tasks
    const userTasks = await Task.find({
      projectId,
      assigneeId: userId
    });

    const completedTasks = userTasks.filter(t => t.status === 'completed' || t.status === 'done');

    // Calculate average time to complete tasks
    let avgCompletionTime = 0;
    if (completedTasks.length > 0) {
      const completionTimes = completedTasks
        .filter(t => t.createdAt && t.updatedAt)
        .map(t => (t.updatedAt.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60)); // Convert to hours

      if (completionTimes.length > 0) {
        avgCompletionTime = completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length;
      }
    }

    const analytics = {
      userId,
      period: {
        startDate: start,
        endDate: end
      },
      summary: {
        tasksAssigned: userTasks.length,
        tasksCompleted: completedTasks.length,
        tasksInProgress: userTasks.filter(t => t.status === 'in-progress' || t.status === 'in_progress').length,
        tasksPending: userTasks.filter(t => t.status === 'todo' || t.status === 'to-do').length,
        completionRate: userTasks.length > 0
          ? ((completedTasks.length / userTasks.length) * 100).toFixed(2)
          : '0.00',
        avgCompletionTimeHours: avgCompletionTime.toFixed(2)
      },
      activity: {
        tasksCreated: stats.tasksCreated,
        tasksUpdated: stats.tasksUpdated,
        tasksCompleted: stats.tasksCompleted,
        totalTimeLogged: stats.totalTimeLogged,
        totalActions: stats.actionsCount
      },
      recentActivity: activityLogs.slice(0, 20)
    };

    return successResponse(res, 'User analytics retrieved successfully', analytics);
  } catch (error) {
    logger.error('Error getting user analytics:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve user analytics');
  }
};

// Get project activity timeline (owner only)
export const getProjectActivity = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { limit, action, userId } = req.query;

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user is owner or manager
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    const isManager = project.managers && project.managers.some((manager: any) => {
      const managerId = typeof manager === 'object' && (manager as any)._id
        ? (manager as any)._id.toString()
        : manager.toString();
      return managerId === req.user._id;
    });

    if (!isOwner && !isInOwners && !isManager) {
      return errorResponse(res, 'Only project owners and managers can view activity', 403);
    }

    // Get activity
    const activity = await AuditLog.getProjectActivity(projectId, {
      action: action as string | undefined,
      userId: userId as string | undefined,
      limit: limit ? parseInt(limit as string) : 100
    });

    return successResponse(res, 'Activity retrieved successfully', activity);
  } catch (error) {
    logger.error('Error getting project activity:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve activity');
  }
};

// Get comprehensive performance matrix for all members
export const getPerformanceMatrix = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { startDate, endDate } = req.query;

    // Check if project exists
    const project = await Project.findById(projectId)
      .populate('members', 'displayName email photoURL')
      .populate('managers', 'displayName email photoURL');

    if (!project) {
      return notFoundResponse(res, 'Project not found');
    }

    // Check if user has access to the project
    const ownerId = typeof project.ownerId === 'object' && (project.ownerId as any)._id
      ? (project.ownerId as any)._id.toString()
      : project.ownerId.toString();

    const isOwner = ownerId === req.user._id;
    const isInOwners = project.owners && project.owners.some((owner: any) => {
      const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
      return owId === req.user._id;
    });

    const isMember = project.members.some((member: any) => {
      const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
      return memberId === req.user._id;
    });

    if (!isOwner && !isInOwners && !isMember) {
      return errorResponse(res, 'Access denied to this project', 403);
    }

    // Set date range (default to last 30 days)
    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get all members (including managers)
    const allMembers = [...project.members];
    if (project.managers) {
      project.managers.forEach((manager: any) => {
        const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
        if (!allMembers.some((m: any) => {
          const mId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
          return mId === managerId;
        })) {
          allMembers.push(manager);
        }
      });
    }

    // Get performance data for each member
    const performanceData = await Promise.all(
      allMembers.map(async (member: any) => {
        const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
        const memberData = typeof member === 'object' ? member : await User.findById(member);

        // Get audit log stats
        const stats = await AuditLog.getUserStats(projectId, memberId, start, end);

        // Get task statistics using assignees array
        const tasksAssigned = await Task.countDocuments({
          projectId,
          assignees: memberId
        });

        const tasksInProgress = await Task.countDocuments({
          projectId,
          assignees: memberId,
          status: { $in: ['in-progress', 'in_progress', 'inprogress'] }
        });

        const tasksCompleted = await Task.countDocuments({
          projectId,
          assignees: memberId,
          status: { $in: ['completed', 'done'] },
          completedAt: { $exists: true, $gte: start, $lte: end }
        });

        const overdueTasks = await Task.countDocuments({
          projectId,
          assignees: memberId,
          status: { $nin: ['completed', 'done'] },  // Not completed (includes todo, in-progress, etc.)
          dueDate: { $exists: true, $lt: new Date() }  // Has due date in the past
        });

        // Calculate average completion time (from assignment to completion)
        const completedTasksForTime = await Task.find({
          projectId,
          assignees: memberId,
          status: { $in: ['completed', 'done'] },
          assignedAt: { $exists: true },
          completedAt: { $exists: true, $gte: start, $lte: end }
        }).select('assignedAt completedAt title');

        let avgCompletionTime = 0;
        if (completedTasksForTime.length > 0) {
          const totalTime = completedTasksForTime.reduce((sum, task: any) => {
            if (task.completedAt && task.assignedAt) {
              // Calculate time from assignment to completion
              const diff = new Date(task.completedAt).getTime() - new Date(task.assignedAt).getTime();
              return sum + diff;
            }
            return sum;
          }, 0);
          avgCompletionTime = totalTime / completedTasksForTime.length / (1000 * 60 * 60); // Convert to hours
        }

        // Calculate productivity score (0-100)
        let productivityScore = 0;
        if (tasksAssigned > 0) {
          // 1. Completion Rate (35 points max) - percentage of tasks completed
          const completionRate = (tasksCompleted / tasksAssigned) * 35;

          // 2. Speed Bonus (15 points max) - faster completion = higher score
          let speedBonus = 0;
          if (avgCompletionTime > 0 && tasksCompleted > 0) {
            // Award points based on completion speed:
            // < 1 hour = 15 points
            // < 4 hours = 12 points
            // < 8 hours = 9 points
            // < 24 hours = 6 points
            // < 48 hours = 3 points
            // >= 48 hours = 0 points
            if (avgCompletionTime < 1) {
              speedBonus = 15;
            } else if (avgCompletionTime < 4) {
              speedBonus = 12;
            } else if (avgCompletionTime < 8) {
              speedBonus = 9;
            } else if (avgCompletionTime < 24) {
              speedBonus = 6;
            } else if (avgCompletionTime < 48) {
              speedBonus = 3;
            }
          }

          // 3. Activity Rate (25 points max) - based on actions taken
          const activityRate = Math.min((stats.actionsCount / 100) * 25, 25);

          // 4. Time Score (15 points max) - based on time logged
          const timeScore = Math.min((stats.totalTimeLogged / 600) * 15, 15); // 600 minutes = 10 hours

          // 5. Overdue Deduction (up to -10 points)
          const overdueDeduction = Math.min(overdueTasks * 2, 10);

          productivityScore = Math.round(completionRate + speedBonus + activityRate + timeScore - overdueDeduction);
          productivityScore = Math.max(0, Math.min(100, productivityScore)); // Clamp between 0-100
        }

        // Get recent activity
        const recentActivity = await AuditLog.getProjectActivity(projectId, {
          userId: memberId,
          startDate: start,
          endDate: end,
          limit: 10
        });

        return {
          userId: memberId,
          userName: memberData?.displayName || 'Unknown',
          userEmail: memberData?.email || '',
          userPhoto: memberData?.photoURL || null,
          tasksAssigned,
          tasksInProgress,
          tasksCompleted,
          overdueTasks,
          tasksCreated: stats.tasksCreated,
          tasksUpdated: stats.tasksUpdated,
          totalTimeLogged: stats.totalTimeLogged,
          actionsCount: stats.actionsCount,
          avgCompletionTime: Math.round(avgCompletionTime * 10) / 10, // Round to 1 decimal
          productivityScore,
          completionRate: tasksAssigned > 0 ? Math.round((tasksCompleted / tasksAssigned) * 100) : 0,
          recentActivity: recentActivity.slice(0, 5) // Last 5 actions
        };
      })
    );

    // Sort by productivity score
    performanceData.sort((a, b) => b.productivityScore - a.productivityScore);

    return successResponse(res, 'Performance matrix retrieved successfully', {
      projectId,
      projectName: project.name,
      startDate: start,
      endDate: end,
      members: performanceData,
      summary: {
        totalMembers: performanceData.length,
        avgProductivityScore: performanceData.length > 0
          ? Math.round(performanceData.reduce((sum, m) => sum + m.productivityScore, 0) / performanceData.length)
          : 0,
        totalTasksAssigned: performanceData.reduce((sum, m) => sum + m.tasksAssigned, 0),
        totalTasksCompleted: performanceData.reduce((sum, m) => sum + m.tasksCompleted, 0),
        totalActionsCount: performanceData.reduce((sum, m) => sum + m.actionsCount, 0)
      }
    });
  } catch (error) {
    logger.error('Error getting performance matrix:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve performance matrix');
  }
};
