import multer from 'multer';
import { Request } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), 'uploads');
const taskAttachmentsDir = path.join(uploadsDir, 'task-attachments');
const chatAttachmentsDir = path.join(uploadsDir, 'chat-attachments');

// Ensure directories exist
[uploadsDir, taskAttachmentsDir, chatAttachmentsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure multer for disk storage (files stored on VPS)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Determine destination based on route
    let dest = uploadsDir;
    if (req.baseUrl.includes('/task/') || req.path.includes('/task/')) {
      dest = taskAttachmentsDir;
    } else if (req.baseUrl.includes('/chat/') || req.path.includes('/chat/')) {
      dest = chatAttachmentsDir;
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with UUID and timestamp
    const uniqueId = uuidv4();
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `${timestamp}-${uniqueId}-${baseName}${ext}`;
    cb(null, fileName);
  }
});

// File filter to restrict file types
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Allow common document and image types
  const allowedTypes = [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
    'image/x-icon',
    // Documents - PDF
    'application/pdf',
    // Documents - Microsoft Word
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // Documents - Microsoft Excel
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Documents - Microsoft PowerPoint
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Documents - OpenOffice/LibreOffice
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    // Documents - Rich Text Format
    'application/rtf',
    'text/rtf',
    // Text files
    'text/plain',
    'text/csv',
    'text/markdown',
    'text/x-markdown',
    // Archives
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/x-tar',
    'application/gzip',
    // Code files
    'text/javascript',
    'application/javascript',
    'application/json',
    'text/html',
    'text/css',
    'application/xml',
    'text/xml',
    // Programming languages
    'text/x-python',
    'text/x-java',
    'text/x-c',
    'text/x-c++',
    'text/x-typescript',
    // Video files (common formats)
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    // Audio files
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    // Other
    'application/octet-stream' // Generic binary
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`));
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size (increased to support larger documents and media)
  }
});

export default upload;
