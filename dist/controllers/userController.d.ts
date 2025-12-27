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
    firebaseUser?: any;
}
export declare const getUsers: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const searchUsers: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getUserById: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=userController.d.ts.map