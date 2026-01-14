import { Request, Response } from 'express';
import { Note } from '../models';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
  };
}

/**
 * Get all notes for the authenticated user
 */
export const getNotes = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const notes = await Note.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();

    successResponse(res, 'Notes retrieved successfully', { notes });
  } catch (error) {
    logger.error('Error in getNotes:', error);
    internalServerErrorResponse(res, 'Failed to retrieve notes');
  }
};

/**
 * Get a single note by ID
 */
export const getNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { id } = req.params;
    const note = await Note.findOne({ _id: id, userId: req.user._id }).lean();

    if (!note) {
      notFoundResponse(res, 'Note not found');
      return;
    }

    successResponse(res, 'Note retrieved successfully', { note });
  } catch (error) {
    logger.error('Error in getNote:', error);
    internalServerErrorResponse(res, 'Failed to retrieve note');
  }
};

/**
 * Create a new note
 */
export const createNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { title, description } = req.body;

    if (!title || !description) {
      errorResponse(res, 'Title and description are required', 400);
      return;
    }

    const note = new Note({
      title: title.trim(),
      description: description.trim(),
      userId: req.user._id
    });

    await note.save();

    successResponse(res, 'Note created successfully', { note }, 201);
  } catch (error) {
    logger.error('Error in createNote:', error);
    internalServerErrorResponse(res, 'Failed to create note');
  }
};

/**
 * Update a note
 */
export const updateNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { id } = req.params;
    const { title, description } = req.body;

    const note = await Note.findOne({ _id: id, userId: req.user._id });

    if (!note) {
      notFoundResponse(res, 'Note not found');
      return;
    }

    if (title !== undefined) {
      note.title = title.trim();
    }
    if (description !== undefined) {
      note.description = description.trim();
    }

    await note.save();

    successResponse(res, 'Note updated successfully', { note });
  } catch (error) {
    logger.error('Error in updateNote:', error);
    internalServerErrorResponse(res, 'Failed to update note');
  }
};

/**
 * Delete a note
 */
export const deleteNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { id } = req.params;
    const note = await Note.findOneAndDelete({ _id: id, userId: req.user._id });

    if (!note) {
      notFoundResponse(res, 'Note not found');
      return;
    }

    successResponse(res, 'Note deleted successfully', {});
  } catch (error) {
    logger.error('Error in deleteNote:', error);
    internalServerErrorResponse(res, 'Failed to delete note');
  }
};
