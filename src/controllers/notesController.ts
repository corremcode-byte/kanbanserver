import { Request, Response } from 'express';
import { Note } from '../models';
import { successResponse, errorResponse, notFoundResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { sanitizeHTMLContent, validateHtmlSize } from '../middleware/sanitizeHtml';

interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
  };
}

/**
 * Get all notes for the authenticated user (owned and shared)
 */
export const getNotes = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    // Find notes owned by user OR shared with user
    const notes = await Note.find({
      $or: [
        { userId: req.user._id },
        { 'sharedWith.userId': req.user._id }
      ]
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Add permission info to each note
    const notesWithPermissions = notes.map(note => ({
      ...note,
      userPermission: note.userId.toString() === req.user!._id.toString()
        ? 'owner'
        : note.sharedWith?.find(sw => sw.userId.toString() === req.user!._id.toString())?.permission || 'none'
    }));

    successResponse(res, 'Notes retrieved successfully', { notes: notesWithPermissions });
  } catch (error) {
    logger.error('Error in getNotes:', error);
    internalServerErrorResponse(res, 'Failed to retrieve notes');
  }
};

/**
 * Get a single note by ID (checks ownership and shared access)
 */
export const getNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { id } = req.params;
    const note = await Note.findOne({
      _id: id,
      $or: [
        { userId: req.user._id },
        { 'sharedWith.userId': req.user._id }
      ]
    }).lean();

    if (!note) {
      notFoundResponse(res, 'Note not found');
      return;
    }

    // Add permission info
    const userPermission = note.userId.toString() === req.user._id.toString()
      ? 'owner'
      : note.sharedWith?.find(sw => sw.userId.toString() === req.user._id.toString())?.permission || 'none';

    successResponse(res, 'Note retrieved successfully', {
      note: { ...note, userPermission }
    });
  } catch (error) {
    logger.error('Error in getNote:', error);
    internalServerErrorResponse(res, 'Failed to retrieve note');
  }
};

/**
 * Create a new note (supports both plain text and HTML)
 */
export const createNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { title, description, content, contentType, reminderDate, reminderFrequency, customReminderMinutes } = req.body;
    if (reminderFrequency !== undefined) {
      const validFrequencies = ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'];
      if (!validFrequencies.includes(reminderFrequency)) {
        errorResponse(res, 'Invalid reminder frequency', 400);
        return;
      }
      if (reminderFrequency !== 'none' && !reminderDate) {
        errorResponse(res, 'Reminder date is required when reminders are enabled', 400);
        return;
      }
      if (reminderFrequency === 'custom') {
        const customMinutes = Number(customReminderMinutes);
        if (!Number.isFinite(customMinutes) || customMinutes < 1) {
          errorResponse(res, 'Custom reminder minutes must be at least 1', 400);
          return;
        }
      }
    }


    // Validate title
    if (!title || title.trim().length === 0) {
      errorResponse(res, 'Title is required', 400);
      return;
    }

    // Validate content (either content or description must be provided)
    const noteContent = content || description;
    if (!noteContent || noteContent.trim().length === 0) {
      errorResponse(res, 'Content is required', 400);
      return;
    }

    // Determine content type
    const type = contentType || (content ? 'html' : 'plain');

    // Sanitize HTML content
    let sanitizedContent = noteContent;
    if (type === 'html') {
      if (!validateHtmlSize(noteContent, 50000)) {
        errorResponse(res, 'Content is too long (max 50,000 characters)', 400);
        return;
      }
      sanitizedContent = sanitizeHTMLContent(noteContent);
    }

    const note = new Note({
      title: title.trim(),
      content: sanitizedContent,
      description: type === 'plain' ? sanitizedContent : undefined, // Backward compatibility
      contentType: type,
      userId: req.user._id,
      reminderDate: reminderDate ? new Date(reminderDate) : undefined,
      reminderFrequency: reminderFrequency || 'none',
      customReminderMinutes: reminderFrequency === 'custom' ? Number(customReminderMinutes) : undefined
    });

    await note.save();

    successResponse(res, 'Note created successfully', { note }, 201);
  } catch (error) {
    logger.error('Error in createNote:', error);
    internalServerErrorResponse(res, 'Failed to create note');
  }
};

/**
 * Update a note (checks edit permission for shared notes)
 */
export const updateNote = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user || !req.user._id) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }

    const { id } = req.params;
    const { title, description, content, contentType, reminderDate, reminderFrequency, customReminderMinutes } = req.body;
    if (reminderFrequency !== undefined) {
      const validFrequencies = ['none', '30minutes', '1hour', '3hours', '12hours', '24hours', '48hours', 'custom'];
      if (!validFrequencies.includes(reminderFrequency)) {
        errorResponse(res, 'Invalid reminder frequency', 400);
        return;
      }
      if (reminderFrequency !== 'none' && !reminderDate) {
        errorResponse(res, 'Reminder date is required when reminders are enabled', 400);
        return;
      }
      if (reminderFrequency === 'custom') {
        const customMinutes = Number(customReminderMinutes);
        if (!Number.isFinite(customMinutes) || customMinutes < 1) {
          errorResponse(res, 'Custom reminder minutes must be at least 1', 400);
          return;
        }
      }
    }


    // Find note (owner or shared with user)
    const note = await Note.findOne({
      _id: id,
      $or: [
        { userId: req.user._id },
        { 'sharedWith.userId': req.user._id }
      ]
    });

    if (!note) {
      notFoundResponse(res, 'Note not found');
      return;
    }

    // Check edit permission
    const isOwner = note.userId.toString() === req.user._id.toString();
    const sharedAccess = note.sharedWith?.find(sw => sw.userId.toString() === req.user._id.toString());
    const hasEditPermission = isOwner || sharedAccess?.permission === 'edit';

    if (!hasEditPermission) {
      errorResponse(res, 'You do not have permission to edit this note', 403);
      return;
    }

    // Update title
    if (title !== undefined) {
      note.title = title.trim();
    }

    // Update content
    if (content !== undefined || description !== undefined) {
      const newContent = content || description;
      const newType = contentType || (content ? 'html' : 'plain');

      // Sanitize HTML content
      let sanitizedContent = newContent;
      if (newType === 'html') {
        if (!validateHtmlSize(newContent, 50000)) {
          errorResponse(res, 'Content is too long (max 50,000 characters)', 400);
          return;
        }
        sanitizedContent = sanitizeHTMLContent(newContent);
      }

      note.content = sanitizedContent;
      note.contentType = newType;
      note.description = newType === 'plain' ? sanitizedContent : undefined; // Backward compatibility
    }

    if (reminderDate !== undefined) {
      note.reminderDate = reminderDate ? new Date(reminderDate) : undefined;
      if (!reminderDate) {
        note.lastReminderSent = undefined;
      }
    }
    if (reminderFrequency !== undefined) {
      note.reminderFrequency = reminderFrequency;
      if (reminderFrequency !== 'custom') {
        note.customReminderMinutes = undefined;
      }
      if (reminderFrequency === 'none') {
        note.lastReminderSent = undefined;
      }
    }
    if (customReminderMinutes !== undefined && reminderFrequency === 'custom') {
      note.customReminderMinutes = Number(customReminderMinutes);
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
