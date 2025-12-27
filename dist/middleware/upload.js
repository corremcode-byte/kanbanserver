"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const multer_1 = __importDefault(require("multer"));
const storage = multer_1.default.memoryStorage();
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
        'image/bmp',
        'image/tiff',
        'image/x-icon',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.presentation',
        'application/rtf',
        'text/rtf',
        'text/plain',
        'text/csv',
        'text/markdown',
        'text/x-markdown',
        'application/zip',
        'application/x-zip-compressed',
        'application/x-rar-compressed',
        'application/x-7z-compressed',
        'application/x-tar',
        'application/gzip',
        'text/javascript',
        'application/javascript',
        'application/json',
        'text/html',
        'text/css',
        'application/xml',
        'text/xml',
        'text/x-python',
        'text/x-java',
        'text/x-c',
        'text/x-c++',
        'text/x-typescript',
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/ogg',
        'audio/webm',
        'application/octet-stream'
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    }
    else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
};
const upload = (0, multer_1.default)({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024,
    }
});
exports.default = upload;
//# sourceMappingURL=upload.js.map