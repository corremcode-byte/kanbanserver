import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
export declare const uploadTaskAttachment: (req: Request, res: Response) => Promise<void>;
export declare const deleteTaskAttachment: (req: Request, res: Response) => Promise<void>;
export declare const getTaskAttachments: (req: Request, res: Response) => Promise<void>;
export declare const uploadChatAttachment: (req: AuthenticatedRequest, res: Response) => Promise<void>;
//# sourceMappingURL=uploadController.d.ts.map