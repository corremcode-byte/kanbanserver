import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
export declare const validate: (schema: Joi.ObjectSchema, property?: "body" | "query" | "params") => (req: Request, res: Response, next: NextFunction) => void;
export declare const commonSchemas: {
    objectId: Joi.StringSchema<string>;
    pagination: Joi.ObjectSchema<any>;
    search: Joi.ObjectSchema<any>;
};
export declare const userSchemas: {
    updateProfile: Joi.ObjectSchema<any>;
};
export declare const teamSchemas: {
    create: Joi.ObjectSchema<any>;
    update: Joi.ObjectSchema<any>;
    addMember: Joi.ObjectSchema<any>;
    removeMember: Joi.ObjectSchema<any>;
};
export declare const projectSchemas: {
    create: Joi.ObjectSchema<any>;
    update: Joi.ObjectSchema<any>;
    addMember: Joi.ObjectSchema<any>;
    removeMember: Joi.ObjectSchema<any>;
};
export declare const taskSchemas: {
    create: Joi.ObjectSchema<any>;
    update: Joi.ObjectSchema<any>;
    addComment: Joi.ObjectSchema<any>;
    addSubtask: Joi.ObjectSchema<any>;
    toggleSubtask: Joi.ObjectSchema<any>;
    addWatcher: Joi.ObjectSchema<any>;
    removeWatcher: Joi.ObjectSchema<any>;
};
export declare const notificationSchemas: {
    markAsRead: Joi.ObjectSchema<any>;
    create: Joi.ObjectSchema<any>;
};
export declare const validateUserUpdate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTeamCreate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTeamUpdate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTeamAddMember: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTeamRemoveMember: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateProjectCreate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateProjectUpdate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateProjectAddMember: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateProjectRemoveMember: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskCreate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskUpdate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskAddComment: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskAddSubtask: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskToggleSubtask: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskAddWatcher: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateTaskRemoveWatcher: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateNotificationMarkAsRead: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateNotificationCreate: (req: Request, res: Response, next: NextFunction) => void;
export declare const validatePagination: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateSearch: (req: Request, res: Response, next: NextFunction) => void;
export declare const validateObjectId: (paramName: string) => (req: Request, res: Response, next: NextFunction) => void;
declare const _default: {
    validate: (schema: Joi.ObjectSchema, property?: "body" | "query" | "params") => (req: Request, res: Response, next: NextFunction) => void;
    commonSchemas: {
        objectId: Joi.StringSchema<string>;
        pagination: Joi.ObjectSchema<any>;
        search: Joi.ObjectSchema<any>;
    };
    userSchemas: {
        updateProfile: Joi.ObjectSchema<any>;
    };
    teamSchemas: {
        create: Joi.ObjectSchema<any>;
        update: Joi.ObjectSchema<any>;
        addMember: Joi.ObjectSchema<any>;
        removeMember: Joi.ObjectSchema<any>;
    };
    projectSchemas: {
        create: Joi.ObjectSchema<any>;
        update: Joi.ObjectSchema<any>;
        addMember: Joi.ObjectSchema<any>;
        removeMember: Joi.ObjectSchema<any>;
    };
    taskSchemas: {
        create: Joi.ObjectSchema<any>;
        update: Joi.ObjectSchema<any>;
        addComment: Joi.ObjectSchema<any>;
        addSubtask: Joi.ObjectSchema<any>;
        toggleSubtask: Joi.ObjectSchema<any>;
        addWatcher: Joi.ObjectSchema<any>;
        removeWatcher: Joi.ObjectSchema<any>;
    };
    notificationSchemas: {
        markAsRead: Joi.ObjectSchema<any>;
        create: Joi.ObjectSchema<any>;
    };
};
export default _default;
//# sourceMappingURL=validation.d.ts.map