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
export declare const sendInvitation: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getProjectInvitations: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getUserInvitations: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getInvitationByToken: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const acceptInvitation: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const completeInvitation: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const rejectInvitation: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const cancelInvitation: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const resendInvitation: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=invitationsController.d.ts.map