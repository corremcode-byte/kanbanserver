"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const uploadsDir = path_1.default.join(process.cwd(), 'uploads');
const taskAttachmentsDir = path_1.default.join(uploadsDir, 'task-attachments');
const chatAttachmentsDir = path_1.default.join(uploadsDir, 'chat-attachments');
[uploadsDir, taskAttachmentsDir, chatAttachmentsDir].forEach(dir => {
    if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
});
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        console.log('📂 Upload destination check:', {
            baseUrl: req.baseUrl,
            path: req.path,
            url: req.url,
            originalUrl: req.originalUrl
        });
        let dest = uploadsDir;
        const fullPath = req.originalUrl || req.url;
        if (req.baseUrl.includes('/task') || req.path.includes('/task') || fullPath.includes('/task')) {
            dest = taskAttachmentsDir;
            console.log('✅ Destination: task-attachments');
        }
        else if (req.baseUrl.includes('/chat') || req.path.includes('/chat') || fullPath.includes('/chat')) {
            dest = chatAttachmentsDir;
            console.log('✅ Destination: chat-attachments');
        }
        else {
            console.log('⚠️ Destination: root uploads (no match)');
        }
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const uniqueId = (0, uuid_1.v4)();
        const timestamp = Date.now();
        const ext = path_1.default.extname(file.originalname);
        const baseName = path_1.default.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `${timestamp}-${uniqueId}-${baseName}${ext}`;
        cb(null, fileName);
    }
});
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