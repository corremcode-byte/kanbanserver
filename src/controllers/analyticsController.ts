import { Request, Response } from 'express';
import { AuditLog, Project, Task, User } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
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

    const currentUserId = req.user?._id;
    
    if (!currentUserId) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Get the current user to check permissions
    const User = (await import('../models/User')).User;
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user is admin OR has view/viewReports permission for performance module
    const isAdmin = currentUser.role === 'admin';
    
    let hasViewPerm = false;
    let hasViewReportsPerm = false;
    try {
      const performanceModulePerms = currentUser.permissions?.modules?.performance;
      if (performanceModulePerms && typeof performanceModulePerms === 'object' && performanceModulePerms !== null) {
        let permsObj: Record<string, unknown>;
        if (typeof (performanceModulePerms as unknown as { toObject?: () => unknown }).toObject === 'function') {
          permsObj = (performanceModulePerms as unknown as { toObject: () => Record<string, unknown> }).toObject();
        } else {
          permsObj = performanceModulePerms as Record<string, unknown>;
        }
        hasViewPerm = permsObj?.view === true;
        hasViewReportsPerm = permsObj?.viewReports === true;
      }
    } catch (permError) {
      logger.error('Error checking performance permissions:', permError);
    }

    // Set date range (default to last 30 days)
    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Handle "all" projects case - requires performance module permission
    if (projectId === 'all') {
      // Check permission for viewing all members' performance
      if (!isAdmin && !hasViewPerm && !hasViewReportsPerm) {
        return errorResponse(res, 'Access denied. You don\'t have permission to view performance of all members.', 403);
      }
      // Get all projects where user is owner, in owners list, or a member
      const allProjects = await Project.find({
        $or: [
          { ownerId: req.user._id },
          { owners: req.user._id },
          { members: req.user._id }
        ]
      }).populate('members', 'displayName email photoURL')
        .populate('managers', 'displayName email photoURL');

      if (allProjects.length === 0) {
        return successResponse(res, 'Performance matrix retrieved successfully', {
          projectId: 'all',
          projectName: 'All Projects',
          startDate: start,
          endDate: end,
          members: [],
          summary: {
            totalMembers: 0,
            avgProductivityScore: 0,
            totalTasksAssigned: 0,
            totalTasksCompleted: 0,
            totalActionsCount: 0
          }
        });
      }

      // Collect all unique members from all projects
      const memberMap = new Map<string, any>();

      for (const project of allProjects) {
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

        for (const member of allMembers) {
          const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
          const memberData = typeof member === 'object' ? member : await User.findById(member);

          if (!memberMap.has(memberId) && memberData) {
            memberMap.set(memberId, memberData);
          }
        }
      }

      // Get performance data for each unique member across all projects
      const performanceData = await Promise.all(
        Array.from(memberMap.entries()).map(async ([memberId, memberData]) => {
          let totalTasksAssigned = 0;
          let totalTasksInProgress = 0;
          let totalTasksCompleted = 0;
          let totalOverdueTasks = 0;
          let totalTasksCreated = 0;
          let totalTasksUpdated = 0;
          let totalTimeLogged = 0;
          let totalActionsCount = 0;
          let totalCompletionTime = 0;
          let completedTasksCount = 0;

          // Aggregate stats across all projects
          for (const project of allProjects) {
            // Get audit log stats
            const stats = await AuditLog.getUserStats(project._id.toString(), memberId, start, end);

            // Get task statistics - check all assignment fields AND createdBy to match dashboard behavior
            const tasksAssigned = await Task.countDocuments({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ]
            });

            const tasksInProgress = await Task.countDocuments({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ],
              status: { $in: ['in-progress', 'in_progress', 'inprogress'] }
            });

            const tasksCompleted = await Task.countDocuments({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ],
              status: 'completed'
            });

            const overdueTasks = await Task.countDocuments({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ],
              status: { $ne: 'completed' },
              dueDate: { $exists: true, $lt: new Date() }
            });

            // Get completed tasks for time calculation (including dueDate for speed bonus)
            const completedTasksForTime = await Task.find({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ],
              status: 'completed',
              assignedAt: { $exists: true },
              completedAt: { $exists: true, $gte: start, $lte: end }
            }).select('assignedAt completedAt dueDate');

            if (completedTasksForTime.length > 0) {
              const projectTime = completedTasksForTime.reduce((sum, task: any) => {
                if (task.completedAt && task.assignedAt) {
                  const diff = new Date(task.completedAt).getTime() - new Date(task.assignedAt).getTime();
                  return sum + diff;
                }
                return sum;
              }, 0);
              totalCompletionTime += projectTime;
              completedTasksCount += completedTasksForTime.length;
            }

            // Aggregate totals
            totalTasksAssigned += tasksAssigned;
            totalTasksInProgress += tasksInProgress;
            totalTasksCompleted += tasksCompleted;
            totalOverdueTasks += overdueTasks;
            totalTasksCreated += stats.tasksCreated;
            totalTasksUpdated += stats.tasksUpdated;
            totalTimeLogged += stats.totalTimeLogged;
            totalActionsCount += stats.actionsCount;
          }

          // Calculate average completion time
          let avgCompletionTime = 0;
          if (completedTasksCount > 0) {
            avgCompletionTime = totalCompletionTime / completedTasksCount / (1000 * 60 * 60); // Convert to hours
          }

          // Calculate speed bonus based on fraction of completion time to deadline (per task, then averaged)
          let speedBonus = 0;
          if (totalTasksCompleted > 0) {
            // Collect all completed tasks with deadlines across all projects
            const allCompletedTasksWithDeadlines: any[] = [];
            for (const project of allProjects) {
              const tasks = await Task.find({
                projectId: project._id,
                $or: [
                  { assigneeId: memberId },
                  { assignedTo: memberId },
                  { assignees: memberId },
                  { createdBy: memberId }
                ],
                status: 'completed',
                assignedAt: { $exists: true },
                completedAt: { $exists: true, $gte: start, $lte: end },
                dueDate: { $exists: true }
              }).select('assignedAt completedAt dueDate');
              allCompletedTasksWithDeadlines.push(...tasks);
            }

            if (allCompletedTasksWithDeadlines.length > 0) {
              // Calculate per-task speed score based on fraction of completion time to deadline
              const taskSpeedScores = allCompletedTasksWithDeadlines.map((task: any) => {
                if (!task.assignedAt || !task.completedAt || !task.dueDate) return 0;

                const assignedAt = new Date(task.assignedAt).getTime();
                const completedAt = new Date(task.completedAt).getTime();
                const dueDate = new Date(task.dueDate).getTime();

                const completionTime = completedAt - assignedAt;
                const availableTime = dueDate - assignedAt;

                if (availableTime <= 0) return 0; // Invalid deadline

                // Calculate fraction: completionTime / availableTime
                // fraction < 1 means completed before deadline (good)
                // fraction > 1 means completed after deadline (bad)
                const fraction = completionTime / availableTime;

                // Map fraction to score (0-15 points)
                // Lower fraction = better performance
                if (fraction < 0.5) {
                  return 15; // Completed in less than half the time
                } else if (fraction < 0.75) {
                  return 12; // Completed in 50-75% of time
                } else if (fraction < 1.0) {
                  return 9; // Completed before deadline
                } else if (fraction < 1.25) {
                  return 6; // Slightly late (0-25% over)
                } else if (fraction < 1.5) {
                  return 3; // Moderately late (25-50% over)
                } else {
                  return 0; // Very late (>50% over deadline)
                }
              });

              // Average the per-task scores
              const totalScore = taskSpeedScores.reduce((sum, score) => sum + score, 0);
              speedBonus = Math.round(totalScore / taskSpeedScores.length);
            }
          }

          // Calculate productivity score
          let productivityScore = 0;
          if (totalTasksAssigned > 0) {
            const completionRate = (totalTasksCompleted / totalTasksAssigned) * 35;

            const activityRate = Math.min((totalActionsCount / 100) * 25, 25);
            const timeScore = Math.min((totalTimeLogged / 600) * 15, 15);
            const overdueDeduction = Math.min(totalOverdueTasks * 2, 10);

            productivityScore = Math.round(completionRate + speedBonus + activityRate + timeScore - overdueDeduction);
            productivityScore = Math.max(0, Math.min(100, productivityScore));
          }

          // Get recent activity from all projects
          const recentActivities = [];
          for (const project of allProjects) {
            const activity = await AuditLog.getProjectActivity(project._id.toString(), {
              userId: memberId,
              startDate: start,
              endDate: end,
              limit: 5
            });
            recentActivities.push(...activity);
          }

          // Sort by date and take the most recent ones
          recentActivities.sort((a: any, b: any) => b.createdAt - a.createdAt);

          // Get task details for this member across all projects - don't filter by date
          const tasks: any[] = [];
          for (const project of allProjects) {
            const memberTasks = await Task.find({
              projectId: project._id,
              $or: [
                { assigneeId: memberId },
                { assignedTo: memberId },
                { assignees: memberId },
                { createdBy: memberId }
              ]
            }).select('title assignees assignedAt completedAt status priority createdAt');

            for (const task of memberTasks) {
              const assignedAt = task.assignedAt || task.createdAt;
              const completedAt = task.completedAt;

              // Calculate time spent: either from assigned to completed, or from assigned to now if not completed
              let timeSpent = 0;
              if (completedAt && assignedAt) {
                timeSpent = (new Date(completedAt).getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60); // hours
              } else if (assignedAt) {
                timeSpent = (new Date().getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60); // hours
              }

              tasks.push({
                taskId: task._id.toString(),
                taskTitle: task.title,
                assignedTo: memberId,
                assignedToName: memberData?.displayName || 'Unknown',
                assignedAt: assignedAt,
                completedAt: completedAt,
                timeSpent: Math.round(timeSpent * 10) / 10,
                status: task.status,
                priority: task.priority,
                assignmentHistory: [] // Simplified for "all projects" view - can add full history if needed
              });
            }
          }

          return {
            userId: memberId,
            userName: memberData?.displayName || 'Unknown',
            userEmail: memberData?.email || '',
            userPhoto: memberData?.photoURL || null,
            tasksAssigned: totalTasksAssigned,
            tasksInProgress: totalTasksInProgress,
            tasksCompleted: totalTasksCompleted,
            overdueTasks: totalOverdueTasks,
            tasksCreated: totalTasksCreated,
            tasksUpdated: totalTasksUpdated,
            totalTimeLogged: totalTimeLogged,
            actionsCount: totalActionsCount,
            avgCompletionTime: Math.round(avgCompletionTime * 10) / 10,
            productivityScore,
            completionRate: totalTasksAssigned > 0 ? Math.round((totalTasksCompleted / totalTasksAssigned) * 100) : 0,
            recentActivity: recentActivities.slice(0, 5),
            tasks: tasks
          };
        })
      );

      // Sort by productivity score
      performanceData.sort((a, b) => b.productivityScore - a.productivityScore);

      return successResponse(res, 'Performance matrix retrieved successfully', {
        projectId: 'all',
        projectName: 'All Projects',
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
    }

    // Single project case
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

        // Get task statistics - check all assignment fields AND createdBy to match dashboard behavior
        const tasksAssigned = await Task.countDocuments({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ]
        });

        const tasksInProgress = await Task.countDocuments({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ],
          status: { $in: ['in-progress', 'in_progress', 'inprogress'] }
        });

        const tasksCompleted = await Task.countDocuments({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ],
          status: 'completed'
        });

        const overdueTasks = await Task.countDocuments({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ],
          status: { $ne: 'completed' },  // Not completed
          dueDate: { $exists: true, $lt: new Date() }  // Has due date in the past
        });

        // Calculate average completion time (from assignment to completion)
        const completedTasksForTime = await Task.find({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ],
          status: 'completed',
          assignedAt: { $exists: true },
          completedAt: { $exists: true, $gte: start, $lte: end }
        }).select('assignedAt completedAt dueDate title');

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

        // Calculate speed bonus based on fraction of completion time to deadline (per task, then averaged)
        let speedBonus = 0;
        if (tasksCompleted > 0) {
          // Get completed tasks with deadlines
          const completedTasksWithDeadlines = await Task.find({
            projectId,
            $or: [
              { assigneeId: memberId },
              { assignedTo: memberId },
              { assignees: memberId },
              { createdBy: memberId }
            ],
            status: 'completed',
            assignedAt: { $exists: true },
            completedAt: { $exists: true, $gte: start, $lte: end },
            dueDate: { $exists: true }
          }).select('assignedAt completedAt dueDate');

          if (completedTasksWithDeadlines.length > 0) {
            // Calculate per-task speed score based on fraction of completion time to deadline
            const taskSpeedScores = completedTasksWithDeadlines.map((task: any) => {
              if (!task.assignedAt || !task.completedAt || !task.dueDate) return 0;

              const assignedAt = new Date(task.assignedAt).getTime();
              const completedAt = new Date(task.completedAt).getTime();
              const dueDate = new Date(task.dueDate).getTime();

              const completionTime = completedAt - assignedAt;
              const availableTime = dueDate - assignedAt;

              if (availableTime <= 0) return 0; // Invalid deadline

              // Calculate fraction: completionTime / availableTime
              // fraction < 1 means completed before deadline (good)
              // fraction > 1 means completed after deadline (bad)
              const fraction = completionTime / availableTime;

              // Map fraction to score (0-15 points)
              // Lower fraction = better performance
              if (fraction < 0.5) {
                return 15; // Completed in less than half the time
              } else if (fraction < 0.75) {
                return 12; // Completed in 50-75% of time
              } else if (fraction < 1.0) {
                return 9; // Completed before deadline
              } else if (fraction < 1.25) {
                return 6; // Slightly late (0-25% over)
              } else if (fraction < 1.5) {
                return 3; // Moderately late (25-50% over)
              } else {
                return 0; // Very late (>50% over deadline)
              }
            });

            // Average the per-task scores
            const totalScore = taskSpeedScores.reduce((sum, score) => sum + score, 0);
            speedBonus = Math.round(totalScore / taskSpeedScores.length);
          }
        }

        // Calculate productivity score (0-100)
        let productivityScore = 0;
        if (tasksAssigned > 0) {
          // 1. Completion Rate (35 points max) - percentage of tasks completed
          const completionRate = (tasksCompleted / tasksAssigned) * 35;

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

        // Get ALL tasks where this member was EVER assigned (including tasks they were reassigned away from)
        // First, find all task IDs from audit logs where this member was involved
        const memberAuditLogs = await AuditLog.find({
          projectId,
          entityType: 'task',
          $or: [
            { 'metadata.oldAssignees': memberId },
            { 'metadata.newAssignees': memberId },
            { userId: memberId }
          ]
        }).distinct('entityId');

        // Also get currently assigned tasks
        const currentlyAssignedTasks = await Task.find({
          projectId,
          $or: [
            { assigneeId: memberId },
            { assignedTo: memberId },
            { assignees: memberId },
            { createdBy: memberId }
          ]
        }).distinct('_id');

        // Combine both lists and get unique task IDs
        const allTaskIds = [...new Set([...memberAuditLogs, ...currentlyAssignedTasks.map(id => id.toString())])];

        // Fetch all tasks
        const memberTasks = await Task.find({
          _id: { $in: allTaskIds }
        }).select('title assignees assignedAt completedAt status priority createdAt');

        const tasks = await Promise.all(memberTasks.map(async (task: any) => {
          const assignedAt = task.assignedAt || task.createdAt;
          const completedAt = task.completedAt;

          // Calculate time spent: either from assigned to completed, or from assigned to now if not completed
          let timeSpent = 0;
          if (completedAt && assignedAt) {
            timeSpent = (new Date(completedAt).getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60); // hours
          } else if (assignedAt) {
            timeSpent = (new Date().getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60); // hours
          }

          // Build assignment history from audit logs
          const assignmentHistory: any[] = [];

          // Get all audit logs related to this task (don't filter by date to get complete history)
          const allTaskAudits = await AuditLog.find({
            projectId,
            entityType: 'task',
            entityId: task._id.toString(),
            action: { $in: ['task_created', 'task_updated', 'task_completed'] }
          }).populate('userId', 'displayName email isActive').sort({ createdAt: 1 });

          // Filter out logs for deleted or inactive users
          const taskAudits: any[] = [];
          
          for (const audit of allTaskAudits) {
            if (audit.userId) {
              const userId = typeof audit.userId === 'object' && (audit.userId as any)._id 
                ? (audit.userId as any)._id.toString() 
                : audit.userId.toString();
              
              // Check if user exists and is active
              const user = await User.findById(userId).select('isActive').lean();
              if (user && user.isActive !== false) {
                taskAudits.push(audit);
              }
            }
          }

          // Track assignment changes - map of userId to their assignment start time
          const assignmentTimes = new Map<string, Date>();
          let currentAssignees = new Set<string>();

          for (const audit of taskAudits) {
            const auditUser = audit.userId as any;

            if (audit.action === 'task_created') {
              // Task was created - record initial assignment from metadata
              const metadata = audit.metadata as any;

              // Helper to extract ID from various formats
              const extractId = (a: any): string => {
                // If it's already a simple string ID (24 hex chars), return it
                if (typeof a === 'string' && /^[0-9a-fA-F]{24}$/.test(a)) return a;

                // If it's a stringified object, try to parse it
                if (typeof a === 'string' && (a.includes('{') || a.includes('ObjectId'))) {
                  try {
                    // Try to extract ObjectId from stringified format
                    const match = a.match(/ObjectId\('([0-9a-fA-F]{24})'\)/);
                    if (match) return match[1];

                    // Try to extract _id from stringified object
                    const idMatch = a.match(/_id:\s*(?:new\s+)?ObjectId\('([0-9a-fA-F]{24})'\)/);
                    if (idMatch) return idMatch[1];

                    // Try parsing as JSON
                    const parsed = JSON.parse(a);
                    if (parsed._id) return parsed._id.toString();
                    return parsed.toString();
                  } catch (e) {
                    // If parsing fails, continue to other methods
                  }
                }

                // If it's an object with _id
                if (a && typeof a === 'object' && a._id) {
                  return a._id.toString();
                }

                // Last resort
                return a.toString();
              };

              const initialAssignees = (metadata?.initialAssignees || []).map(extractId);

              if (initialAssignees.length > 0) {
                for (const assigneeId of initialAssignees) {
                  const assignee = await User.findById(assigneeId).select('displayName email');
                  if (assignee) {
                    const assigneeIdStr = assigneeId.toString();
                    currentAssignees.add(assigneeIdStr);
                    assignmentTimes.set(assigneeIdStr, new Date(audit.createdAt));
                    assignmentHistory.push({
                      assignedTo: assigneeIdStr,
                      assignedToName: assignee.displayName,
                      assignedToEmail: assignee.email,
                      assignedAt: audit.createdAt,
                      timeSpent: 0,
                      action: 'assigned'
                    });
                  }
                }
              }
            } else if (audit.action === 'task_updated') {
              // Check if assignees changed in this update
              const metadata = audit.metadata as any;
              if (metadata && metadata.assigneesChanged) {
                // Get assignees from audit log metadata (historical data)
                // Ensure we extract just the IDs in case they're objects or stringified objects
                const extractId = (a: any): string => {
                  // If it's already a simple string ID (24 hex chars), return it
                  if (typeof a === 'string' && /^[0-9a-fA-F]{24}$/.test(a)) return a;

                  // If it's a stringified object, try to parse it
                  if (typeof a === 'string' && (a.includes('{') || a.includes('ObjectId'))) {
                    try {
                      // Try to extract ObjectId from stringified format
                      const match = a.match(/ObjectId\('([0-9a-fA-F]{24})'\)/);
                      if (match) return match[1];

                      // Try to extract _id from stringified object
                      const idMatch = a.match(/_id:\s*(?:new\s+)?ObjectId\('([0-9a-fA-F]{24})'\)/);
                      if (idMatch) return idMatch[1];

                      // Try parsing as JSON
                      const parsed = JSON.parse(a);
                      if (parsed._id) return parsed._id.toString();
                      return parsed.toString();
                    } catch (e) {
                      // If parsing fails, continue to other methods
                    }
                  }

                  // If it's an object with _id
                  if (a && typeof a === 'object' && a._id) {
                    return a._id.toString();
                  }

                  // Last resort
                  return a.toString();
                };

                const newAssignees = (metadata.newAssignees || []).map(extractId);
                const oldAssigneesFromMetadata = (metadata.oldAssignees || []).map(extractId);
                const newAssigneeSet = new Set<string>(newAssignees);

                // Find removed assignees (reassigned away)
                for (const oldAssignee of currentAssignees) {
                  if (!newAssigneeSet.has(oldAssignee)) {
                    const assignee = await User.findById(oldAssignee).select('displayName email');
                    if (assignee) {
                      // Calculate time this person had the task
                      const assignStartTime = assignmentTimes.get(oldAssignee);
                      const timeOnTask = assignStartTime ?
                        (new Date(audit.createdAt).getTime() - assignStartTime.getTime()) / (1000 * 60 * 60) : 0;

                      assignmentHistory.push({
                        assignedTo: oldAssignee,
                        assignedToName: assignee.displayName,
                        assignedToEmail: assignee.email,
                        assignedAt: assignStartTime || audit.createdAt,
                        reassignedAt: audit.createdAt,
                        timeSpent: Math.round(timeOnTask * 10) / 10,
                        action: 'reassigned'
                      });

                      // Remove from tracking
                      assignmentTimes.delete(oldAssignee);
                    }
                  }
                }

                // Find new assignees
                for (const newAssigneeId of newAssigneeSet) {
                  if (!currentAssignees.has(newAssigneeId)) {
                    const assignee = await User.findById(newAssigneeId).select('displayName email');
                    if (assignee) {
                      assignmentTimes.set(newAssigneeId, new Date(audit.createdAt));
                      assignmentHistory.push({
                        assignedTo: newAssigneeId,
                        assignedToName: assignee.displayName,
                        assignedToEmail: assignee.email,
                        assignedAt: audit.createdAt,
                        timeSpent: 0,
                        action: 'assigned'
                      });
                    }
                  }
                }

                currentAssignees = newAssigneeSet;
              }
            } else if (audit.action === 'task_completed') {
              // Task completed - calculate final time for all current assignees
              for (const assigneeId of currentAssignees) {
                const assignee = await User.findById(assigneeId).select('displayName email');
                if (assignee) {
                  const assignStartTime = assignmentTimes.get(assigneeId);
                  const timeOnTask = assignStartTime ?
                    (new Date(audit.createdAt).getTime() - assignStartTime.getTime()) / (1000 * 60 * 60) : 0;

                  assignmentHistory.push({
                    assignedTo: assigneeId,
                    assignedToName: assignee.displayName,
                    assignedToEmail: assignee.email,
                    assignedAt: assignStartTime || audit.createdAt,
                    completedAt: audit.createdAt,
                    timeSpent: Math.round(timeOnTask * 10) / 10,
                    action: 'completed'
                  });

                  assignmentTimes.delete(assigneeId);
                }
              }
            }
          }

          return {
            taskId: task._id.toString(),
            taskTitle: task.title,
            assignedTo: memberId,
            assignedToName: memberData?.displayName || 'Unknown',
            assignedAt: assignedAt,
            completedAt: completedAt,
            timeSpent: Math.round(timeSpent * 10) / 10,
            status: task.status,
            priority: task.priority,
            assignmentHistory: assignmentHistory
          };
        }));

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
          recentActivity: recentActivity.slice(0, 5), // Last 5 actions
          tasks: tasks
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
