import { Request, Response, NextFunction } from 'express';
export interface AuthenticatedRequest extends Request {
    user?: any;
    firebaseUser?: any;
}
export declare const authenticate: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
export declare const optionalAuth: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
export declare const requireManagerOrAdmin: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireAdmin: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const authorize: (roles: string[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireActiveUser: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireEmailVerified: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const getCurrentUserId: (req: AuthenticatedRequest) => string | null;
export declare const requireOwnershipOrAdmin: (resourceUserId: string) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const authenticateFirebaseToken: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=auth.d.ts.map