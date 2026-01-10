import { Request, Response, NextFunction } from 'express';
interface AuthenticatedRequest extends Request {
    user?: {
        _id: string;
        firebaseUid: string;
        email: string;
        displayName: string;
        role: string;
        isManager: boolean;
    };
}
type Permission = 'canCreateTasks' | 'canEditTasks' | 'canDeleteTasks' | 'canAssignTasks' | 'canEditProject' | 'canManageMembers' | 'canViewAllTasks' | 'canManagePermissions' | 'canCreateChatGroups' | 'canDeleteChatGroups';
export declare const checkPermission: (permission: Permission) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
export declare const checkCanEditTask: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
export declare const checkCanDeleteTask: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
export declare const checkTaskAccess: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=permissions.d.ts.map