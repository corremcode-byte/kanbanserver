export declare const generalLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const authLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const createLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const uploadLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const passwordResetLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const emailVerificationLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const searchLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const exportLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const createRateLimiter: (windowMs: number, max: number, message: string) => import("express-rate-limit").RateLimitRequestHandler;
declare const _default: {
    generalLimiter: import("express-rate-limit").RateLimitRequestHandler;
    authLimiter: import("express-rate-limit").RateLimitRequestHandler;
    createLimiter: import("express-rate-limit").RateLimitRequestHandler;
    uploadLimiter: import("express-rate-limit").RateLimitRequestHandler;
    passwordResetLimiter: import("express-rate-limit").RateLimitRequestHandler;
    emailVerificationLimiter: import("express-rate-limit").RateLimitRequestHandler;
    searchLimiter: import("express-rate-limit").RateLimitRequestHandler;
    exportLimiter: import("express-rate-limit").RateLimitRequestHandler;
    createRateLimiter: (windowMs: number, max: number, message: string) => import("express-rate-limit").RateLimitRequestHandler;
};
export default _default;
//# sourceMappingURL=rateLimiter.d.ts.map