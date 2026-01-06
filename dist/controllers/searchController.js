"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.search = void 0;
const logger_1 = require("../utils/logger");
const Task_1 = __importDefault(require("../models/Task"));
const Project_1 = __importDefault(require("../models/Project"));
const responses_1 = require("../utils/responses");
const search = async (req, res) => {
    try {
        const { q: query } = req.query;
        if (!query || typeof query !== 'string') {
            return (0, responses_1.errorResponse)(res, 'Search query is required', 400);
        }
        const userId = req.user._id.toString();
        const userProjects = await Project_1.default.find({
            $or: [
                { ownerId: userId },
                { members: userId },
                { managers: userId }
            ]
        }).select('_id name description');
        const projectIds = userProjects.map(p => p._id);
        const projects = userProjects.filter(project => project.name.toLowerCase().includes(query.toLowerCase()) ||
            (project.description && project.description.toLowerCase().includes(query.toLowerCase())));
        const tasks = await Task_1.default.find({
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
        logger_1.logger.info(`Search performed by ${req.user.email} for query: "${query}"`);
        return (0, responses_1.successResponse)(res, 'Search results retrieved successfully', {
            tasks,
            projects: projects.slice(0, 10)
        });
    }
    catch (error) {
        logger_1.logger.error('Error in search:', error);
        return (0, responses_1.internalServerErrorResponse)(res, 'Failed to perform search');
    }
};
exports.search = search;
//# sourceMappingURL=searchController.js.map