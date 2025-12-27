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
export declare const logTime: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTaskTimeLogs: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getProjectTimeLogs: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getUserTimeLogs: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTimeLog: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteTimeLog: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=timeTrackingController.d.ts.map