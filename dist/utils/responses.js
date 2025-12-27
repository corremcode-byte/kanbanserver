"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noContentResponse = exports.createdResponse = exports.paginatedResponse = exports.formatJoiErrors = exports.formatMongooseErrors = exports.tooManyRequestsResponse = exports.internalServerErrorResponse = exports.validationErrorResponse = exports.forbiddenResponse = exports.unauthorizedResponse = exports.notFoundResponse = exports.errorResponse = exports.successResponse = void 0;
const successResponse = (res, message, data, statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data
    });
};
exports.successResponse = successResponse;
const errorResponse = (res, message, statusCode = 400) => {
    return res.status(statusCode).json({
        success: false,
        message
    });
};
exports.errorResponse = errorResponse;
const notFoundResponse = (res, message = 'Resource not found') => {
    return res.status(404).json({
        success: false,
        message
    });
};
exports.notFoundResponse = notFoundResponse;
const unauthorizedResponse = (res, message = 'Unauthorized') => {
    return res.status(401).json({
        success: false,
        message
    });
};
exports.unauthorizedResponse = unauthorizedResponse;
const forbiddenResponse = (res, message = 'Forbidden') => {
    return res.status(403).json({
        success: false,
        message
    });
};
exports.forbiddenResponse = forbiddenResponse;
const validationErrorResponse = (res, message, errors) => {
    return res.status(422).json({
        success: false,
        message,
        errors
    });
};
exports.validationErrorResponse = validationErrorResponse;
const internalServerErrorResponse = (res, message = 'Internal server error') => {
    return res.status(500).json({
        success: false,
        message
    });
};
exports.internalServerErrorResponse = internalServerErrorResponse;
const tooManyRequestsResponse = (res, message = 'Too many requests') => {
    return res.status(429).json({
        success: false,
        message
    });
};
exports.tooManyRequestsResponse = tooManyRequestsResponse;
const formatMongooseErrors = (error) => {
    const errors = [];
    if (error.errors) {
        Object.values(error.errors).forEach((err) => {
            errors.push({
                field: err.path,
                message: err.message,
                value: err.value
            });
        });
    }
    return errors;
};
exports.formatMongooseErrors = formatMongooseErrors;
const formatJoiErrors = (error) => {
    const errors = [];
    if (error.details) {
        error.details.forEach((detail) => {
            errors.push({
                field: detail.path.join('.'),
                message: detail.message,
                value: detail.context?.value
            });
        });
    }
    return errors;
};
exports.formatJoiErrors = formatJoiErrors;
const paginatedResponse = (res, message, data, pagination, statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        pagination
    });
};
exports.paginatedResponse = paginatedResponse;
const createdResponse = (res, message, data) => {
    return (0, exports.successResponse)(res, message, data, 201);
};
exports.createdResponse = createdResponse;
const noContentResponse = (res) => {
    return res.status(204).send();
};
exports.noContentResponse = noContentResponse;
exports.default = {
    successResponse: exports.successResponse,
    errorResponse: exports.errorResponse,
    notFoundResponse: exports.notFoundResponse,
    unauthorizedResponse: exports.unauthorizedResponse,
    forbiddenResponse: exports.forbiddenResponse,
    validationErrorResponse: exports.validationErrorResponse,
    internalServerErrorResponse: exports.internalServerErrorResponse,
    tooManyRequestsResponse: exports.tooManyRequestsResponse,
    formatMongooseErrors: exports.formatMongooseErrors,
    formatJoiErrors: exports.formatJoiErrors,
    paginatedResponse: exports.paginatedResponse,
    createdResponse: exports.createdResponse,
    noContentResponse: exports.noContentResponse
};
//# sourceMappingURL=responses.js.map