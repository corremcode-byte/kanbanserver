import { Response } from 'express';
export declare const successResponse: (res: Response, message: string, data?: any, statusCode?: number) => Response<any, Record<string, any>>;
export declare const errorResponse: (res: Response, message: string, statusCode?: number) => Response<any, Record<string, any>>;
export declare const notFoundResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
export declare const unauthorizedResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
export declare const forbiddenResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
export declare const validationErrorResponse: (res: Response, message: string, errors: any[]) => Response<any, Record<string, any>>;
export declare const internalServerErrorResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
export declare const tooManyRequestsResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
export declare const formatMongooseErrors: (error: any) => any[];
export declare const formatJoiErrors: (error: any) => any[];
export declare const paginatedResponse: (res: Response, message: string, data: any[], pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}, statusCode?: number) => Response<any, Record<string, any>>;
export declare const createdResponse: (res: Response, message: string, data?: any) => Response<any, Record<string, any>>;
export declare const noContentResponse: (res: Response) => Response<any, Record<string, any>>;
declare const _default: {
    successResponse: (res: Response, message: string, data?: any, statusCode?: number) => Response<any, Record<string, any>>;
    errorResponse: (res: Response, message: string, statusCode?: number) => Response<any, Record<string, any>>;
    notFoundResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
    unauthorizedResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
    forbiddenResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
    validationErrorResponse: (res: Response, message: string, errors: any[]) => Response<any, Record<string, any>>;
    internalServerErrorResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
    tooManyRequestsResponse: (res: Response, message?: string) => Response<any, Record<string, any>>;
    formatMongooseErrors: (error: any) => any[];
    formatJoiErrors: (error: any) => any[];
    paginatedResponse: (res: Response, message: string, data: any[], pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    }, statusCode?: number) => Response<any, Record<string, any>>;
    createdResponse: (res: Response, message: string, data?: any) => Response<any, Record<string, any>>;
    noContentResponse: (res: Response) => Response<any, Record<string, any>>;
};
export default _default;
//# sourceMappingURL=responses.d.ts.map