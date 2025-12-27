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
export declare const getProjectAnalytics: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getUserAnalytics: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getProjectActivity: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getPerformanceMatrix: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=analyticsController.d.ts.map