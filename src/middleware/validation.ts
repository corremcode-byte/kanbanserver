import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { validationErrorResponse, formatJoiErrors } from '../utils/responses';

// Generic validation middleware factory
export const validate = (schema: Joi.ObjectSchema, property: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: true
    });

    if (error) {
      const errors = formatJoiErrors(error);
      validationErrorResponse(res, 'Validation failed', errors);
      return;
    }

    // Replace the original data with the validated and cleaned data
    req[property] = value;
    next();
  };
};

// Common validation schemas
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).message('Invalid ID format');

// Base pagination schema
const paginationFields = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  sort: Joi.string(),
  order: Joi.string().valid('asc', 'desc').default('desc')
};

const pagination = Joi.object(paginationFields);

export const commonSchemas = {
  objectId,
  pagination,
  search: Joi.object({
    q: Joi.string().trim().max(100),
    filter: Joi.string(),
    // Properly include pagination fields
    ...paginationFields
  })
};

// User validation schemas
export const userSchemas = {
  updateProfile: Joi.object({
    displayName: Joi.string().trim().max(100),
    photoURL: Joi.string().uri(),
    preferences: Joi.object({
      theme: Joi.string().valid('light', 'dark', 'system'),
      notifications: Joi.object({
        email: Joi.boolean(),
        push: Joi.boolean(),
        inApp: Joi.boolean()
      }),
      defaultView: Joi.string().valid('list', 'board', 'calendar', 'timeline')
    }),
    profile: Joi.object({
      timezone: Joi.string(),
      language: Joi.string().max(10),
      jobTitle: Joi.string().max(100),
      department: Joi.string().max(100)
    })
  })
};

// Team validation schemas
export const teamSchemas = {
  create: Joi.object({
    name: Joi.string().required().trim().max(100),
    description: Joi.string().trim().max(500),
    settings: Joi.object({
      isPrivate: Joi.boolean().default(false),
      allowGuestAccess: Joi.boolean().default(false),
      defaultProjectPermission: Joi.string().valid('view', 'edit', 'admin').default('edit')
    }),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i)
  }),

  update: Joi.object({
    name: Joi.string().trim().max(100),
    description: Joi.string().trim().max(500),
    settings: Joi.object({
      isPrivate: Joi.boolean(),
      allowGuestAccess: Joi.boolean(),
      defaultProjectPermission: Joi.string().valid('view', 'edit', 'admin')
    }),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i)
  }),

  addMember: Joi.object({
    userId: objectId.required()
  }),

  removeMember: Joi.object({
    userId: objectId.required()
  })
};

// Project validation schemas
export const projectSchemas = {
  create: Joi.object({
    name: Joi.string().required().trim().max(100),
    description: Joi.string().trim().max(1000),
    teamId: objectId.required(),
    defaultView: Joi.string().valid('list', 'board', 'calendar', 'timeline').default('list'),
    startDate: Joi.date(),
    dueDate: Joi.date().min(Joi.ref('startDate')),
    status: Joi.string().valid('planning', 'active', 'on-hold', 'completed', 'archived').default('planning'),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i),
    isPublic: Joi.boolean().default(false),
    settings: Joi.object({
      allowComments: Joi.boolean().default(true),
      allowFileAttachments: Joi.boolean().default(true),
      notifyOnUpdates: Joi.boolean().default(true),
      autoArchiveCompletedTasks: Joi.boolean().default(false)
    }),
    tags: Joi.array().items(Joi.string().trim().max(50)),
    members: Joi.array().items(objectId)
  }),

  update: Joi.object({
    name: Joi.string().trim().max(100),
    description: Joi.string().trim().max(1000),
    defaultView: Joi.string().valid('list', 'board', 'calendar', 'timeline'),
    startDate: Joi.date(),
    dueDate: Joi.date(),
    status: Joi.string().valid('planning', 'active', 'on-hold', 'completed', 'archived'),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent'),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i),
    isPublic: Joi.boolean(),
    settings: Joi.object({
      allowComments: Joi.boolean(),
      allowFileAttachments: Joi.boolean(),
      notifyOnUpdates: Joi.boolean(),
      autoArchiveCompletedTasks: Joi.boolean()
    }),
    tags: Joi.array().items(Joi.string().trim().max(50))
  }),

  addMember: Joi.object({
    userId: objectId.required()
  }),

  removeMember: Joi.object({
    userId: objectId.required()
  })
};

// Task validation schemas
export const taskSchemas = {
  create: Joi.object({
    title: Joi.string().required().trim().max(200),
    description: Joi.string().trim().max(2000),
    assignedTo: objectId,
    status: Joi.string().valid('todo', 'in-progress', 'review', 'completed', 'cancelled').default('todo'),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
    dueDate: Joi.date(),
    startDate: Joi.date(),
    estimatedHours: Joi.number().min(0),
    tags: Joi.array().items(Joi.string().trim().max(50)),
    position: Joi.number().default(0),
    boardColumn: Joi.string().default('todo'),
    customFields: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      value: Joi.any(),
      type: Joi.string().valid('text', 'number', 'date', 'select', 'multiselect', 'user', 'boolean').required()
    })),
    watchers: Joi.array().items(objectId)
  }),

  update: Joi.object({
    title: Joi.string().trim().max(200),
    description: Joi.string().trim().max(2000),
    assignedTo: objectId,
    status: Joi.string().valid('todo', 'in-progress', 'review', 'completed', 'cancelled'),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent'),
    dueDate: Joi.date(),
    startDate: Joi.date(),
    estimatedHours: Joi.number().min(0),
    tags: Joi.array().items(Joi.string().trim().max(50)),
    position: Joi.number(),
    boardColumn: Joi.string(),
    customFields: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      value: Joi.any(),
      type: Joi.string().valid('text', 'number', 'date', 'select', 'multiselect', 'user', 'boolean').required()
    })),
    watchers: Joi.array().items(objectId)
  }),

  addComment: Joi.object({
    content: Joi.string().required().trim().max(2000)
  }),

  addSubtask: Joi.object({
    title: Joi.string().required().trim().max(200),
    assignedTo: objectId,
    dueDate: Joi.date()
  }),

  toggleSubtask: Joi.object({
    subtaskId: objectId.required(),
    completed: Joi.boolean().required()
  }),

  addWatcher: Joi.object({
    userId: objectId.required()
  }),

  removeWatcher: Joi.object({
    userId: objectId.required()
  })
};

// Notification validation schemas
export const notificationSchemas = {
  markAsRead: Joi.object({
    notificationIds: Joi.array().items(objectId).min(1).required()
  }),

  create: Joi.object({
    type: Joi.string().required(),
    message: Joi.string().required().trim().max(500),
    recipientId: objectId.required(),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
    actionUrl: Joi.string(),
    payload: Joi.object()
  })
};

// Export validation middleware for each schema
export const validateUserUpdate = validate(userSchemas.updateProfile);

export const validateTeamCreate = validate(teamSchemas.create);
export const validateTeamUpdate = validate(teamSchemas.update);
export const validateTeamAddMember = validate(teamSchemas.addMember);
export const validateTeamRemoveMember = validate(teamSchemas.removeMember);

export const validateProjectCreate = validate(projectSchemas.create);
export const validateProjectUpdate = validate(projectSchemas.update);
export const validateProjectAddMember = validate(projectSchemas.addMember);
export const validateProjectRemoveMember = validate(projectSchemas.removeMember);

export const validateTaskCreate = validate(taskSchemas.create);
export const validateTaskUpdate = validate(taskSchemas.update);
export const validateTaskAddComment = validate(taskSchemas.addComment);
export const validateTaskAddSubtask = validate(taskSchemas.addSubtask);
export const validateTaskToggleSubtask = validate(taskSchemas.toggleSubtask);
export const validateTaskAddWatcher = validate(taskSchemas.addWatcher);
export const validateTaskRemoveWatcher = validate(taskSchemas.removeWatcher);

export const validateNotificationMarkAsRead = validate(notificationSchemas.markAsRead);
export const validateNotificationCreate = validate(notificationSchemas.create);

export const validatePagination = validate(commonSchemas.pagination, 'query');
export const validateSearch = validate(commonSchemas.search, 'query');

export const validateObjectId = (paramName: string) => 
  validate(Joi.object({ [paramName]: objectId.required() }), 'params');

export default {
  validate,
  commonSchemas,
  userSchemas,
  teamSchemas,
  projectSchemas,
  taskSchemas,
  notificationSchemas
};