import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import Task from '../models/Task';
import Project from '../models/Project';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { decryptTaskFields, decryptProjectFields } from '../utils/fieldEncryption';

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

    // name/description are encrypted at rest — decrypt each candidate before matching.
    userProjects.forEach((p: any) => decryptProjectFields(p));

    // Search for projects by name or description
    const projects = userProjects.filter(project =>
      project.name.toLowerCase().includes(query.toLowerCase()) ||
      (project.description && project.description.toLowerCase().includes(query.toLowerCase()))
    );

    // Search for tasks by title or description within user's projects.
    // description is encrypted at rest, so it can't be matched with a DB-level
    // $regex — fetch the in-scope candidates, decrypt, then filter/sort/limit in
    // app code. Same endpoint contract and result set as before, just computed
    // in Node instead of in MongoDB.
    const queryRegex = new RegExp(query, 'i');
    const candidateTasks = await Task.find({ projectId: { $in: projectIds } })
      .populate('projectId', 'name')
      .populate('assignees', 'displayName email avatar photoURL outOfOfficePeriods')
      .populate('assignedTo', 'displayName email avatar photoURL outOfOfficePeriods')
      .sort({ updatedAt: -1 })
      .lean();

    const tasks = candidateTasks
      .map((t: any) => decryptTaskFields(t))
      .filter((t: any) => queryRegex.test(t.title) || (t.description && queryRegex.test(t.description)))
      .slice(0, 20);

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
