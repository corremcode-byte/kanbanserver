"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPerformanceMatrix = exports.getProjectActivity = exports.getUserAnalytics = exports.getProjectAnalytics = void 0;
const models_1 = require("../models");
const responses_1 = require("../utils/responses");
const logger_1 = require("../utils/logger");
const getProjectAnalytics = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { startDate, endDate, userId } = req.query;
        const project = await models_1.Project.findById(projectId)
            .populate('members', 'displayName email photoURL')
            .populate('managers', 'displayName email photoURL');
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        if (!isOwner && !isInOwners) {
            return (0, responses_1.errorResponse)(res, 'Only project owners can view analytics', 403);
        }
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();
        const activityLogs = await models_1.AuditLog.getProjectActivity(projectId, {
            userId: userId,
            startDate: start,
            endDate: end,
            limit: 1000
        });
        const allTasks = await models_1.Task.find({ projectId });
        const completedTasks = allTasks.filter(t => t.status === 'completed' || t.status === 'done');
        const memberStats = [];
        for (const member of project.members) {
            const memberId = typeof member === 'object' && member._id
                ? member._id.toString()
                : member.toString();
            const stats = await models_1.AuditLog.getUserStats(projectId, memberId, start, end);
            const memberTasks = allTasks.filter(t => {
                const assigneeId = t.assigneeId ? t.assigneeId.toString() : null;
                return assigneeId === memberId;
            });
            const memberCompletedTasks = memberTasks.filter(t => t.status === 'completed' || t.status === 'done');
            memberStats.push({
                userId: memberId,
                user: member.displayName || member.email || 'Unknown',
                email: member.email,
                photoURL: member.photoURL,
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
        memberStats.sort((a, b) => b.actionsCount - a.actionsCount);
        const actionDistribution = {};
        activityLogs.forEach((log) => {
            actionDistribution[log.action] = (actionDistribution[log.action] || 0) + 1;
        });
        const dailyActivity = {};
        activityLogs.forEach((log) => {
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
            recentActivity: activityLogs.slice(0, 50)
        };
        return (0, responses_1.successResponse)(res, 'Analytics retrieved successfully', analytics);
    }
    catch (error) {
        logger_1.logger.error('Error getting project analytics:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve analytics');
    }
};
exports.getProjectAnalytics = getProjectAnalytics;
const getUserAnalytics = async (req, res) => {
    try {
        const { projectId, userId } = req.params;
        const { startDate, endDate } = req.query;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        if (!isOwner && !isInOwners) {
            return (0, responses_1.errorResponse)(res, 'Only project owners can view user analytics', 403);
        }
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();
        const stats = await models_1.AuditLog.getUserStats(projectId, userId, start, end);
        const activityLogs = await models_1.AuditLog.getProjectActivity(projectId, {
            userId,
            startDate: start,
            endDate: end,
            limit: 100
        });
        const userTasks = await models_1.Task.find({
            projectId,
            assigneeId: userId
        });
        const completedTasks = userTasks.filter(t => t.status === 'completed' || t.status === 'done');
        let avgCompletionTime = 0;
        if (completedTasks.length > 0) {
            const completionTimes = completedTasks
                .filter(t => t.createdAt && t.updatedAt)
                .map(t => (t.updatedAt.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60));
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
        return (0, responses_1.successResponse)(res, 'User analytics retrieved successfully', analytics);
    }
    catch (error) {
        logger_1.logger.error('Error getting user analytics:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve user analytics');
    }
};
exports.getUserAnalytics = getUserAnalytics;
const getProjectActivity = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { limit, action, userId } = req.query;
        const project = await models_1.Project.findById(projectId);
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        const isManager = project.managers && project.managers.some((manager) => {
            const managerId = typeof manager === 'object' && manager._id
                ? manager._id.toString()
                : manager.toString();
            return managerId === req.user._id;
        });
        if (!isOwner && !isInOwners && !isManager) {
            return (0, responses_1.errorResponse)(res, 'Only project owners and managers can view activity', 403);
        }
        const activity = await models_1.AuditLog.getProjectActivity(projectId, {
            action: action,
            userId: userId,
            limit: limit ? parseInt(limit) : 100
        });
        return (0, responses_1.successResponse)(res, 'Activity retrieved successfully', activity);
    }
    catch (error) {
        logger_1.logger.error('Error getting project activity:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve activity');
    }
};
exports.getProjectActivity = getProjectActivity;
const getPerformanceMatrix = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { startDate, endDate } = req.query;
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        if (projectId === 'all') {
            const allProjects = await models_1.Project.find({
                $or: [
                    { ownerId: req.user._id },
                    { owners: req.user._id },
                    { members: req.user._id }
                ]
            }).populate('members', 'displayName email photoURL')
                .populate('managers', 'displayName email photoURL');
            if (allProjects.length === 0) {
                return (0, responses_1.successResponse)(res, 'Performance matrix retrieved successfully', {
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
            const memberMap = new Map();
            for (const project of allProjects) {
                const allMembers = [...project.members];
                if (project.managers) {
                    project.managers.forEach((manager) => {
                        const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
                        if (!allMembers.some((m) => {
                            const mId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
                            return mId === managerId;
                        })) {
                            allMembers.push(manager);
                        }
                    });
                }
                for (const member of allMembers) {
                    const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
                    const memberData = typeof member === 'object' ? member : await models_1.User.findById(member);
                    if (!memberMap.has(memberId) && memberData) {
                        memberMap.set(memberId, memberData);
                    }
                }
            }
            const performanceData = await Promise.all(Array.from(memberMap.entries()).map(async ([memberId, memberData]) => {
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
                for (const project of allProjects) {
                    const stats = await models_1.AuditLog.getUserStats(project._id.toString(), memberId, start, end);
                    const tasksAssigned = await models_1.Task.countDocuments({
                        projectId: project._id,
                        $or: [
                            { assigneeId: memberId },
                            { assignedTo: memberId },
                            { assignees: memberId },
                            { createdBy: memberId }
                        ]
                    });
                    const tasksInProgress = await models_1.Task.countDocuments({
                        projectId: project._id,
                        $or: [
                            { assigneeId: memberId },
                            { assignedTo: memberId },
                            { assignees: memberId },
                            { createdBy: memberId }
                        ],
                        status: { $in: ['in-progress', 'in_progress', 'inprogress'] }
                    });
                    const tasksCompleted = await models_1.Task.countDocuments({
                        projectId: project._id,
                        $or: [
                            { assigneeId: memberId },
                            { assignedTo: memberId },
                            { assignees: memberId },
                            { createdBy: memberId }
                        ],
                        status: 'completed'
                    });
                    const overdueTasks = await models_1.Task.countDocuments({
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
                    const completedTasksForTime = await models_1.Task.find({
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
                    }).select('assignedAt completedAt');
                    if (completedTasksForTime.length > 0) {
                        const projectTime = completedTasksForTime.reduce((sum, task) => {
                            if (task.completedAt && task.assignedAt) {
                                const diff = new Date(task.completedAt).getTime() - new Date(task.assignedAt).getTime();
                                return sum + diff;
                            }
                            return sum;
                        }, 0);
                        totalCompletionTime += projectTime;
                        completedTasksCount += completedTasksForTime.length;
                    }
                    totalTasksAssigned += tasksAssigned;
                    totalTasksInProgress += tasksInProgress;
                    totalTasksCompleted += tasksCompleted;
                    totalOverdueTasks += overdueTasks;
                    totalTasksCreated += stats.tasksCreated;
                    totalTasksUpdated += stats.tasksUpdated;
                    totalTimeLogged += stats.totalTimeLogged;
                    totalActionsCount += stats.actionsCount;
                }
                let avgCompletionTime = 0;
                if (completedTasksCount > 0) {
                    avgCompletionTime = totalCompletionTime / completedTasksCount / (1000 * 60 * 60);
                }
                let productivityScore = 0;
                if (totalTasksAssigned > 0) {
                    const completionRate = (totalTasksCompleted / totalTasksAssigned) * 35;
                    let speedBonus = 0;
                    if (avgCompletionTime > 0 && totalTasksCompleted > 0) {
                        if (avgCompletionTime < 1) {
                            speedBonus = 15;
                        }
                        else if (avgCompletionTime < 4) {
                            speedBonus = 12;
                        }
                        else if (avgCompletionTime < 8) {
                            speedBonus = 9;
                        }
                        else if (avgCompletionTime < 24) {
                            speedBonus = 6;
                        }
                        else if (avgCompletionTime < 48) {
                            speedBonus = 3;
                        }
                    }
                    const activityRate = Math.min((totalActionsCount / 100) * 25, 25);
                    const timeScore = Math.min((totalTimeLogged / 600) * 15, 15);
                    const overdueDeduction = Math.min(totalOverdueTasks * 2, 10);
                    productivityScore = Math.round(completionRate + speedBonus + activityRate + timeScore - overdueDeduction);
                    productivityScore = Math.max(0, Math.min(100, productivityScore));
                }
                const recentActivities = [];
                for (const project of allProjects) {
                    const activity = await models_1.AuditLog.getProjectActivity(project._id.toString(), {
                        userId: memberId,
                        startDate: start,
                        endDate: end,
                        limit: 5
                    });
                    recentActivities.push(...activity);
                }
                recentActivities.sort((a, b) => b.createdAt - a.createdAt);
                const tasks = [];
                for (const project of allProjects) {
                    const memberTasks = await models_1.Task.find({
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
                        let timeSpent = 0;
                        if (completedAt && assignedAt) {
                            timeSpent = (new Date(completedAt).getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60);
                        }
                        else if (assignedAt) {
                            timeSpent = (new Date().getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60);
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
                            assignmentHistory: []
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
            }));
            performanceData.sort((a, b) => b.productivityScore - a.productivityScore);
            return (0, responses_1.successResponse)(res, 'Performance matrix retrieved successfully', {
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
        const project = await models_1.Project.findById(projectId)
            .populate('members', 'displayName email photoURL')
            .populate('managers', 'displayName email photoURL');
        if (!project) {
            return (0, responses_1.notFoundResponse)(res, 'Project not found');
        }
        const ownerId = typeof project.ownerId === 'object' && project.ownerId._id
            ? project.ownerId._id.toString()
            : project.ownerId.toString();
        const isOwner = ownerId === req.user._id;
        const isInOwners = project.owners && project.owners.some((owner) => {
            const owId = typeof owner === 'object' && owner._id ? owner._id.toString() : owner.toString();
            return owId === req.user._id;
        });
        const isMember = project.members.some((member) => {
            const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
            return memberId === req.user._id;
        });
        if (!isOwner && !isInOwners && !isMember) {
            return (0, responses_1.errorResponse)(res, 'Access denied to this project', 403);
        }
        const allMembers = [...project.members];
        if (project.managers) {
            project.managers.forEach((manager) => {
                const managerId = typeof manager === 'object' && manager._id ? manager._id.toString() : manager.toString();
                if (!allMembers.some((m) => {
                    const mId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
                    return mId === managerId;
                })) {
                    allMembers.push(manager);
                }
            });
        }
        const performanceData = await Promise.all(allMembers.map(async (member) => {
            const memberId = typeof member === 'object' && member._id ? member._id.toString() : member.toString();
            const memberData = typeof member === 'object' ? member : await models_1.User.findById(member);
            const stats = await models_1.AuditLog.getUserStats(projectId, memberId, start, end);
            const tasksAssigned = await models_1.Task.countDocuments({
                projectId,
                $or: [
                    { assigneeId: memberId },
                    { assignedTo: memberId },
                    { assignees: memberId },
                    { createdBy: memberId }
                ]
            });
            const tasksInProgress = await models_1.Task.countDocuments({
                projectId,
                $or: [
                    { assigneeId: memberId },
                    { assignedTo: memberId },
                    { assignees: memberId },
                    { createdBy: memberId }
                ],
                status: { $in: ['in-progress', 'in_progress', 'inprogress'] }
            });
            const tasksCompleted = await models_1.Task.countDocuments({
                projectId,
                $or: [
                    { assigneeId: memberId },
                    { assignedTo: memberId },
                    { assignees: memberId },
                    { createdBy: memberId }
                ],
                status: 'completed'
            });
            const overdueTasks = await models_1.Task.countDocuments({
                projectId,
                $or: [
                    { assigneeId: memberId },
                    { assignedTo: memberId },
                    { assignees: memberId },
                    { createdBy: memberId }
                ],
                status: { $ne: 'completed' },
                dueDate: { $exists: true, $lt: new Date() }
            });
            const completedTasksForTime = await models_1.Task.find({
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
            }).select('assignedAt completedAt title');
            let avgCompletionTime = 0;
            if (completedTasksForTime.length > 0) {
                const totalTime = completedTasksForTime.reduce((sum, task) => {
                    if (task.completedAt && task.assignedAt) {
                        const diff = new Date(task.completedAt).getTime() - new Date(task.assignedAt).getTime();
                        return sum + diff;
                    }
                    return sum;
                }, 0);
                avgCompletionTime = totalTime / completedTasksForTime.length / (1000 * 60 * 60);
            }
            let productivityScore = 0;
            if (tasksAssigned > 0) {
                const completionRate = (tasksCompleted / tasksAssigned) * 35;
                let speedBonus = 0;
                if (avgCompletionTime > 0 && tasksCompleted > 0) {
                    if (avgCompletionTime < 1) {
                        speedBonus = 15;
                    }
                    else if (avgCompletionTime < 4) {
                        speedBonus = 12;
                    }
                    else if (avgCompletionTime < 8) {
                        speedBonus = 9;
                    }
                    else if (avgCompletionTime < 24) {
                        speedBonus = 6;
                    }
                    else if (avgCompletionTime < 48) {
                        speedBonus = 3;
                    }
                }
                const activityRate = Math.min((stats.actionsCount / 100) * 25, 25);
                const timeScore = Math.min((stats.totalTimeLogged / 600) * 15, 15);
                const overdueDeduction = Math.min(overdueTasks * 2, 10);
                productivityScore = Math.round(completionRate + speedBonus + activityRate + timeScore - overdueDeduction);
                productivityScore = Math.max(0, Math.min(100, productivityScore));
            }
            const recentActivity = await models_1.AuditLog.getProjectActivity(projectId, {
                userId: memberId,
                startDate: start,
                endDate: end,
                limit: 10
            });
            const memberAuditLogs = await models_1.AuditLog.find({
                projectId,
                entityType: 'task',
                $or: [
                    { 'metadata.oldAssignees': memberId },
                    { 'metadata.newAssignees': memberId },
                    { userId: memberId }
                ]
            }).distinct('entityId');
            const currentlyAssignedTasks = await models_1.Task.find({
                projectId,
                $or: [
                    { assigneeId: memberId },
                    { assignedTo: memberId },
                    { assignees: memberId },
                    { createdBy: memberId }
                ]
            }).distinct('_id');
            const allTaskIds = [...new Set([...memberAuditLogs, ...currentlyAssignedTasks.map(id => id.toString())])];
            const memberTasks = await models_1.Task.find({
                _id: { $in: allTaskIds }
            }).select('title assignees assignedAt completedAt status priority createdAt');
            const tasks = await Promise.all(memberTasks.map(async (task) => {
                const assignedAt = task.assignedAt || task.createdAt;
                const completedAt = task.completedAt;
                let timeSpent = 0;
                if (completedAt && assignedAt) {
                    timeSpent = (new Date(completedAt).getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60);
                }
                else if (assignedAt) {
                    timeSpent = (new Date().getTime() - new Date(assignedAt).getTime()) / (1000 * 60 * 60);
                }
                const assignmentHistory = [];
                const taskAudits = await models_1.AuditLog.find({
                    projectId,
                    entityType: 'task',
                    entityId: task._id.toString(),
                    action: { $in: ['task_created', 'task_updated', 'task_completed'] }
                }).populate('userId', 'displayName email').sort({ createdAt: 1 });
                const assignmentTimes = new Map();
                let currentAssignees = new Set();
                for (const audit of taskAudits) {
                    const auditUser = audit.userId;
                    if (audit.action === 'task_created') {
                        const metadata = audit.metadata;
                        const extractId = (a) => {
                            if (typeof a === 'string' && /^[0-9a-fA-F]{24}$/.test(a))
                                return a;
                            if (typeof a === 'string' && (a.includes('{') || a.includes('ObjectId'))) {
                                try {
                                    const match = a.match(/ObjectId\('([0-9a-fA-F]{24})'\)/);
                                    if (match)
                                        return match[1];
                                    const idMatch = a.match(/_id:\s*(?:new\s+)?ObjectId\('([0-9a-fA-F]{24})'\)/);
                                    if (idMatch)
                                        return idMatch[1];
                                    const parsed = JSON.parse(a);
                                    if (parsed._id)
                                        return parsed._id.toString();
                                    return parsed.toString();
                                }
                                catch (e) {
                                }
                            }
                            if (a && typeof a === 'object' && a._id) {
                                return a._id.toString();
                            }
                            return a.toString();
                        };
                        const initialAssignees = (metadata?.initialAssignees || []).map(extractId);
                        if (initialAssignees.length > 0) {
                            for (const assigneeId of initialAssignees) {
                                const assignee = await models_1.User.findById(assigneeId).select('displayName email');
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
                    }
                    else if (audit.action === 'task_updated') {
                        const metadata = audit.metadata;
                        if (metadata && metadata.assigneesChanged) {
                            const extractId = (a) => {
                                if (typeof a === 'string' && /^[0-9a-fA-F]{24}$/.test(a))
                                    return a;
                                if (typeof a === 'string' && (a.includes('{') || a.includes('ObjectId'))) {
                                    try {
                                        const match = a.match(/ObjectId\('([0-9a-fA-F]{24})'\)/);
                                        if (match)
                                            return match[1];
                                        const idMatch = a.match(/_id:\s*(?:new\s+)?ObjectId\('([0-9a-fA-F]{24})'\)/);
                                        if (idMatch)
                                            return idMatch[1];
                                        const parsed = JSON.parse(a);
                                        if (parsed._id)
                                            return parsed._id.toString();
                                        return parsed.toString();
                                    }
                                    catch (e) {
                                    }
                                }
                                if (a && typeof a === 'object' && a._id) {
                                    return a._id.toString();
                                }
                                return a.toString();
                            };
                            const newAssignees = (metadata.newAssignees || []).map(extractId);
                            const oldAssigneesFromMetadata = (metadata.oldAssignees || []).map(extractId);
                            const newAssigneeSet = new Set(newAssignees);
                            for (const oldAssignee of currentAssignees) {
                                if (!newAssigneeSet.has(oldAssignee)) {
                                    const assignee = await models_1.User.findById(oldAssignee).select('displayName email');
                                    if (assignee) {
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
                                        assignmentTimes.delete(oldAssignee);
                                    }
                                }
                            }
                            for (const newAssigneeId of newAssigneeSet) {
                                if (!currentAssignees.has(newAssigneeId)) {
                                    const assignee = await models_1.User.findById(newAssigneeId).select('displayName email');
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
                    }
                    else if (audit.action === 'task_completed') {
                        for (const assigneeId of currentAssignees) {
                            const assignee = await models_1.User.findById(assigneeId).select('displayName email');
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
                avgCompletionTime: Math.round(avgCompletionTime * 10) / 10,
                productivityScore,
                completionRate: tasksAssigned > 0 ? Math.round((tasksCompleted / tasksAssigned) * 100) : 0,
                recentActivity: recentActivity.slice(0, 5),
                tasks: tasks
            };
        }));
        performanceData.sort((a, b) => b.productivityScore - a.productivityScore);
        return (0, responses_1.successResponse)(res, 'Performance matrix retrieved successfully', {
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
    }
    catch (error) {
        logger_1.logger.error('Error getting performance matrix:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to retrieve performance matrix');
    }
};
exports.getPerformanceMatrix = getPerformanceMatrix;
//# sourceMappingURL=analyticsController.js.map