import multer from 'multer';
import { Request } from 'express';

// Configure multer for memory storage (we'll upload to Firebase from memory)
const storage = multer.memoryStorage();

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
