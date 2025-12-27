import { Request, Response, NextFunction } from 'express';
interface AuthenticatedRequest extends Request {
    user?: any;
}
export declare class AppError extends Error {
    statusCode: number;
    isOperational: boolean;
    constructor(message: string, statusCode?: number, isOperational?: boolean);
}
export declare const asyncHandler: (fn: Function) => (req: Request, res: Response, next: NextFunction) => void;
export declare const globalErrorHandler: (err: any, req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const notFoundHandler: (req: Request, res: Response, next: NextFunction) => void;
export declare const handleUnhandledRejections: () => void;
export declare const handleUncaughtExceptions: () => void;
export declare const handleGracefulShutdown: (server: any) => void;
export declare const handleValidationErrors: (error: any) => AppError;
export declare const handleRateLimitError: () => AppError;
export declare const handleDatabaseError: (error: any) => AppError;
declare const _default: {
    AppError: typeof AppError;
    asyncHandler: (fn: Function) => (req: Request, res: Response, next: NextFunction) => void;
    globalErrorHandler: (err: any, req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
    notFoundHandler: (req: Request, res: Response, next: NextFunction) => void;
    handleUnhandledRejections: () => void;
    handleUncaughtExceptions: () => void;
    handleGracefulShutdown: (server: any) => void;
    handleValidationErrors: (error: any) => AppError;
    handleRateLimitError: () => AppError;
    handleDatabaseError: (error: any) => AppError;
};
export default _default;
//# sourceMappingURL=errorHandler.d.ts.map