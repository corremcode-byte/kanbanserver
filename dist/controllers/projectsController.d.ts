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
export declare const getProjects: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getProject: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createProject: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateProject: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteProject: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const addMember: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const removeMember: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMemberRole: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const addOwner: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const removeOwner: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const transferOwnership: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const leaveProject: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const addList: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateList: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteList: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const reorderLists: (req: AuthenticatedRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export {};
//# sourceMappingURL=projectsController.d.ts.map