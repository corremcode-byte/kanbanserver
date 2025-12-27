import { Response } from 'express';

export const successResponse = (res: Response, message: string, data?: any, statusCode: number = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data
  });
};

export const errorResponse = (res: Response, message: string, statusCode: number = 400) => {
  return res.status(statusCode).json({
    success: false,
    message
  });
};

export const notFoundResponse = (res: Response, message: string = 'Resource not found') => {
  return res.status(404).json({
    success: false,
    message
  });
};

export const unauthorizedResponse = (res: Response, message: string = 'Unauthorized') => {
  return res.status(401).json({
    success: false,
    message
  });
};

export const forbiddenResponse = (res: Response, message: string = 'Forbidden') => {
  return res.status(403).json({
    success: false,
    message
  });
};

export const validationErrorResponse = (res: Response, message: string, errors: any[]) => {
  return res.status(422).json({
    success: false,
    message,
    errors
  });
};

export const internalServerErrorResponse = (res: Response, message: string = 'Internal server error') => {
  return res.status(500).json({
    success: false,
    message
  });
};

export const tooManyRequestsResponse = (res: Response, message: string = 'Too many requests') => {
  return res.status(429).json({
    success: false,
    message
  });
};

// Helper function to format Mongoose validation errors
export const formatMongooseErrors = (error: any) => {
  const errors: any[] = [];
  
  if (error.errors) {
    Object.values(error.errors).forEach((err: any) => {
      errors.push({
        field: err.path,
        message: err.message,
        value: err.value
      });
    });
  }
  
  return errors;
};

// Helper function to format Joi validation errors
export const formatJoiErrors = (error: any) => {
  const errors: any[] = [];
  
  if (error.details) {
    error.details.forEach((detail: any) => {
      errors.push({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      });
    });
  }
  
  return errors;
};

// Helper function for paginated responses
export const paginatedResponse = (
  res: Response, 
  message: string, 
  data: any[], 
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  },
  statusCode: number = 200
) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    pagination
  });
};

// Helper function for created resource responses
export const createdResponse = (res: Response, message: string, data?: any) => {
  return successResponse(res, message, data, 201);
};

// Helper function for no content responses
export const noContentResponse = (res: Response) => {
  return res.status(204).send();
};

export default {
  successResponse,
  errorResponse,
  notFoundResponse,
  unauthorizedResponse,
  forbiddenResponse,
  validationErrorResponse,
  internalServerErrorResponse,
  tooManyRequestsResponse,
  formatMongooseErrors,
  formatJoiErrors,
  paginatedResponse,
  createdResponse,
  noContentResponse
};