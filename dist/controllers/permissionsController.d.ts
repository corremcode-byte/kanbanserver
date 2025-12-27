import { Request, Response } from 'express';
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
export declare const getProjectPermissions: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getUserPermission: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateUserPermission: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteUserPermission: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getMyPermission: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=permissionsController.d.ts.map