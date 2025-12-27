"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateObjectId = exports.validateSearch = exports.validatePagination = exports.validateNotificationCreate = exports.validateNotificationMarkAsRead = exports.validateTaskRemoveWatcher = exports.validateTaskAddWatcher = exports.validateTaskToggleSubtask = exports.validateTaskAddSubtask = exports.validateTaskAddComment = exports.validateTaskUpdate = exports.validateTaskCreate = exports.validateProjectRemoveMember = exports.validateProjectAddMember = exports.validateProjectUpdate = exports.validateProjectCreate = exports.validateTeamRemoveMember = exports.validateTeamAddMember = exports.validateTeamUpdate = exports.validateTeamCreate = exports.validateUserUpdate = exports.notificationSchemas = exports.taskSchemas = exports.projectSchemas = exports.teamSchemas = exports.userSchemas = exports.commonSchemas = exports.validate = void 0;
const joi_1 = __importDefault(require("joi"));
const responses_1 = require("../utils/responses");
const validate = (schema, property = 'body') => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req[property], {
            abortEarly: false,
            allowUnknown: false,
            stripUnknown: true
        });
        if (error) {
            const errors = (0, responses_1.formatJoiErrors)(error);
            (0, responses_1.validationErrorResponse)(res, 'Validation failed', errors);
            return;
        }
        req[property] = value;
        next();
    };
};
exports.validate = validate;
const objectId = joi_1.default.string().pattern(/^[0-9a-fA-F]{24}$/).message('Invalid ID format');
const paginationFields = {
    page: joi_1.default.number().integer().min(1).default(1),
    limit: joi_1.default.number().integer().min(1).max(100).default(10),
    sort: joi_1.default.string(),
    order: joi_1.default.string().valid('asc', 'desc').default('desc')
};
const pagination = joi_1.default.object(paginationFields);
exports.commonSchemas = {
    objectId,
    pagination,
    search: joi_1.default.object({
        q: joi_1.default.string().trim().max(100),
        filter: joi_1.default.string(),
        ...paginationFields
    })
};
exports.userSchemas = {
    updateProfile: joi_1.default.object({
        displayName: joi_1.default.string().trim().max(100),
        photoURL: joi_1.default.string().uri(),
        preferences: joi_1.default.object({
            theme: joi_1.default.string().valid('light', 'dark', 'system'),
            notifications: joi_1.default.object({
                email: joi_1.default.boolean(),
                push: joi_1.default.boolean(),
                inApp: joi_1.default.boolean()
            }),
            defaultView: joi_1.default.string().valid('list', 'board', 'calendar', 'timeline')
        }),
        profile: joi_1.default.object({
            timezone: joi_1.default.string(),
            language: joi_1.default.string().max(10),
            jobTitle: joi_1.default.string().max(100),
            department: joi_1.default.string().max(100)
        })
    })
};
exports.teamSchemas = {
    create: joi_1.default.object({
        name: joi_1.default.string().required().trim().max(100),
        description: joi_1.default.string().trim().max(500),
        settings: joi_1.default.object({
            isPrivate: joi_1.default.boolean().default(false),
            allowGuestAccess: joi_1.default.boolean().default(false),
            defaultProjectPermission: joi_1.default.string().valid('view', 'edit', 'admin').default('edit')
        }),
        color: joi_1.default.string().pattern(/^#[0-9A-F]{6}$/i)
    }),
    update: joi_1.default.object({
        name: joi_1.default.string().trim().max(100),
        description: joi_1.default.string().trim().max(500),
        settings: joi_1.default.object({
            isPrivate: joi_1.default.boolean(),
            allowGuestAccess: joi_1.default.boolean(),
            defaultProjectPermission: joi_1.default.string().valid('view', 'edit', 'admin')
        }),
        color: joi_1.default.string().pattern(/^#[0-9A-F]{6}$/i)
    }),
    addMember: joi_1.default.object({
        userId: objectId.required()
    }),
    removeMember: joi_1.default.object({
        userId: objectId.required()
    })
};
exports.projectSchemas = {
    create: joi_1.default.object({
        name: joi_1.default.string().required().trim().max(100),
        description: joi_1.default.string().trim().max(1000),
        teamId: objectId.required(),
        defaultView: joi_1.default.string().valid('list', 'board', 'calendar', 'timeline').default('list'),
        startDate: joi_1.default.date(),
        dueDate: joi_1.default.date().min(joi_1.default.ref('startDate')),
        status: joi_1.default.string().valid('planning', 'active', 'on-hold', 'completed', 'archived').default('planning'),
        priority: joi_1.default.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
        color: joi_1.default.string().pattern(/^#[0-9A-F]{6}$/i),
        isPublic: joi_1.default.boolean().default(false),
        settings: joi_1.default.object({
            allowComments: joi_1.default.boolean().default(true),
            allowFileAttachments: joi_1.default.boolean().default(true),
            notifyOnUpdates: joi_1.default.boolean().default(true),
            autoArchiveCompletedTasks: joi_1.default.boolean().default(false)
        }),
        tags: joi_1.default.array().items(joi_1.default.string().trim().max(50)),
        members: joi_1.default.array().items(objectId)
    }),
    update: joi_1.default.object({
        name: joi_1.default.string().trim().max(100),
        description: joi_1.default.string().trim().max(1000),
        defaultView: joi_1.default.string().valid('list', 'board', 'calendar', 'timeline'),
        startDate: joi_1.default.date(),
        dueDate: joi_1.default.date(),
        status: joi_1.default.string().valid('planning', 'active', 'on-hold', 'completed', 'archived'),
        priority: joi_1.default.string().valid('low', 'medium', 'high', 'urgent'),
        color: joi_1.default.string().pattern(/^#[0-9A-F]{6}$/i),
        isPublic: joi_1.default.boolean(),
        settings: joi_1.default.object({
            allowComments: joi_1.default.boolean(),
            allowFileAttachments: joi_1.default.boolean(),
            notifyOnUpdates: joi_1.default.boolean(),
            autoArchiveCompletedTasks: joi_1.default.boolean()
        }),
        tags: joi_1.default.array().items(joi_1.default.string().trim().max(50))
    }),
    addMember: joi_1.default.object({
        userId: objectId.required()
    }),
    removeMember: joi_1.default.object({
        userId: objectId.required()
    })
};
exports.taskSchemas = {
    create: joi_1.default.object({
        title: joi_1.default.string().required().trim().max(200),
        description: joi_1.default.string().trim().max(2000),
        assignedTo: objectId,
        status: joi_1.default.string().valid('todo', 'in-progress', 'review', 'completed', 'cancelled').default('todo'),
        priority: joi_1.default.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
        dueDate: joi_1.default.date(),
        startDate: joi_1.default.date(),
        estimatedHours: joi_1.default.number().min(0),
        tags: joi_1.default.array().items(joi_1.default.string().trim().max(50)),
        position: joi_1.default.number().default(0),
        boardColumn: joi_1.default.string().default('todo'),
        customFields: joi_1.default.array().items(joi_1.default.object({
            name: joi_1.default.string().required(),
            value: joi_1.default.any(),
            type: joi_1.default.string().valid('text', 'number', 'date', 'select', 'multiselect', 'user', 'boolean').required()
        })),
        watchers: joi_1.default.array().items(objectId)
    }),
    update: joi_1.default.object({
        title: joi_1.default.string().trim().max(200),
        description: joi_1.default.string().trim().max(2000),
        assignedTo: objectId,
        status: joi_1.default.string().valid('todo', 'in-progress', 'review', 'completed', 'cancelled'),
        priority: joi_1.default.string().valid('low', 'medium', 'high', 'urgent'),
        dueDate: joi_1.default.date(),
        startDate: joi_1.default.date(),
        estimatedHours: joi_1.default.number().min(0),
        tags: joi_1.default.array().items(joi_1.default.string().trim().max(50)),
        position: joi_1.default.number(),
        boardColumn: joi_1.default.string(),
        customFields: joi_1.default.array().items(joi_1.default.object({
            name: joi_1.default.string().required(),
            value: joi_1.default.any(),
            type: joi_1.default.string().valid('text', 'number', 'date', 'select', 'multiselect', 'user', 'boolean').required()
        })),
        watchers: joi_1.default.array().items(objectId)
    }),
    addComment: joi_1.default.object({
        content: joi_1.default.string().required().trim().max(2000)
    }),
    addSubtask: joi_1.default.object({
        title: joi_1.default.string().required().trim().max(200),
        assignedTo: objectId,
        dueDate: joi_1.default.date()
    }),
    toggleSubtask: joi_1.default.object({
        subtaskId: objectId.required(),
        completed: joi_1.default.boolean().required()
    }),
    addWatcher: joi_1.default.object({
        userId: objectId.required()
    }),
    removeWatcher: joi_1.default.object({
        userId: objectId.required()
    })
};
exports.notificationSchemas = {
    markAsRead: joi_1.default.object({
        notificationIds: joi_1.default.array().items(objectId).min(1).required()
    }),
    create: joi_1.default.object({
        type: joi_1.default.string().required(),
        message: joi_1.default.string().required().trim().max(500),
        recipientId: objectId.required(),
        priority: joi_1.default.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
        actionUrl: joi_1.default.string(),
        payload: joi_1.default.object()
    })
};
exports.validateUserUpdate = (0, exports.validate)(exports.userSchemas.updateProfile);
exports.validateTeamCreate = (0, exports.validate)(exports.teamSchemas.create);
exports.validateTeamUpdate = (0, exports.validate)(exports.teamSchemas.update);
exports.validateTeamAddMember = (0, exports.validate)(exports.teamSchemas.addMember);
exports.validateTeamRemoveMember = (0, exports.validate)(exports.teamSchemas.removeMember);
exports.validateProjectCreate = (0, exports.validate)(exports.projectSchemas.create);
exports.validateProjectUpdate = (0, exports.validate)(exports.projectSchemas.update);
exports.validateProjectAddMember = (0, exports.validate)(exports.projectSchemas.addMember);
exports.validateProjectRemoveMember = (0, exports.validate)(exports.projectSchemas.removeMember);
exports.validateTaskCreate = (0, exports.validate)(exports.taskSchemas.create);
exports.validateTaskUpdate = (0, exports.validate)(exports.taskSchemas.update);
exports.validateTaskAddComment = (0, exports.validate)(exports.taskSchemas.addComment);
exports.validateTaskAddSubtask = (0, exports.validate)(exports.taskSchemas.addSubtask);
exports.validateTaskToggleSubtask = (0, exports.validate)(exports.taskSchemas.toggleSubtask);
exports.validateTaskAddWatcher = (0, exports.validate)(exports.taskSchemas.addWatcher);
exports.validateTaskRemoveWatcher = (0, exports.validate)(exports.taskSchemas.removeWatcher);
exports.validateNotificationMarkAsRead = (0, exports.validate)(exports.notificationSchemas.markAsRead);
exports.validateNotificationCreate = (0, exports.validate)(exports.notificationSchemas.create);
exports.validatePagination = (0, exports.validate)(exports.commonSchemas.pagination, 'query');
exports.validateSearch = (0, exports.validate)(exports.commonSchemas.search, 'query');
const validateObjectId = (paramName) => (0, exports.validate)(joi_1.default.object({ [paramName]: objectId.required() }), 'params');
exports.validateObjectId = validateObjectId;
exports.default = {
    validate: exports.validate,
    commonSchemas: exports.commonSchemas,
    userSchemas: exports.userSchemas,
    teamSchemas: exports.teamSchemas,
    projectSchemas: exports.projectSchemas,
    taskSchemas: exports.taskSchemas,
    notificationSchemas: exports.notificationSchemas
};
//# sourceMappingURL=validation.js.map