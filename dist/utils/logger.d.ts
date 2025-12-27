import winston from 'winston';
export declare const logger: winston.Logger;
export declare const morganStream: {
    write: (message: string) => void;
};
export declare const logError: (message: string, error?: any, metadata?: any) => void;
export declare const logInfo: (message: string, metadata?: object) => void;
export declare const logWarn: (message: string, metadata?: object) => void;
export declare const logDebug: (message: string, metadata?: object) => void;
export declare const logPerformance: (operation: string, duration: number, metadata?: object) => void;
export declare const logApiRequest: (method: string, url: string, statusCode: number, duration: number, userId?: string) => void;
export default logger;
//# sourceMappingURL=logger.d.ts.map