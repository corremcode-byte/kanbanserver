import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import Task from '../models/Task';
import Project from '../models/Project';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

/**
 * Global search across tasks and projects
 * Searches only in projects where the user is a member, owner, or manager
 */
export const search = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { q: query } = req.query;

    if (!query || typeof query !== 'string') {
      return errorResponse(res, 'Search query is required', 400);
    }

    const userId = req.user!._id.toString();

    // Find all projects the user has access to
    const userProjects = await Project.find({
      $or: [
        { ownerId: userId },
        { members: userId },
        { managers: userId }
      ]
    }).select('_id name description');

    const projectIds = userProjects.map(p => p._id);

    // Search for projects by name or description
    const projects = userProjects.filter(project =>
      project.name.toLowerCase().includes(query.toLowerCase()) ||
      (project.description && project.description.toLowerCase().includes(query.toLowerCase()))
    );

    // Search for tasks by title or description within user's projects
    const tasks = await Task.find({
      projectId: { $in: projectIds },
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { description: { $regex: query, $options: 'i' } }
      ]
    })
      .populate('projectId', 'name')
      .populate('assignees', 'displayName email avatar photoURL')
      .populate('assignedTo', 'displayName email avatar photoURL')
      .limit(20)
      .sort({ updatedAt: -1 });

    logger.info(`Search performed by ${req.user!.email} for query: "${query}"`);

    return successResponse(res, 'Search results retrieved successfully', {
      tasks,
      projects: projects.slice(0, 10) // Limit projects to 10 results
    });
  } catch (error) {
    logger.error('Error in search:', error);
    return internalServerErrorResponse(res, 'Failed to perform search');
  }
};
