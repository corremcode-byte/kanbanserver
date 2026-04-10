import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Create uploads directories if they don't exist
const avatarsDir = path.join(__dirname, '../../uploads/avatars');
const attachmentsDir = path.join(__dirname, '../../uploads/attachments');
const taskAttachmentsDir = path.join(__dirname, '../../uploads/task-attachments');
const chatAttachmentsDir = path.join(__dirname, '../../uploads/chat-attachments');
const supportAttachmentsDir = path.join(__dirname, '../../uploads/support-attachments');

if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

if (!fs.existsSync(taskAttachmentsDir)) {
  fs.mkdirSync(taskAttachmentsDir, { recursive: true });
}

if (!fs.existsSync(chatAttachmentsDir)) {
  fs.mkdirSync(chatAttachmentsDir, { recursive: true });
}

if (!fs.existsSync(supportAttachmentsDir)) {
  fs.mkdirSync(supportAttachmentsDir, { recursive: true });
}

// Configure storage for avatars
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: userId-timestamp-originalname
    const userId = (req as any).user?._id || 'unknown';
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const filename = `${userId}-${timestamp}${ext}`;
    cb(null, filename);
  }
});

// Configure storage for general attachments (tasks, chat)
const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, attachmentsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-originalname
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const filename = `${timestamp}-${basename}${ext}`;
    cb(null, filename);
  }
});

// Configure storage for task attachments
const taskAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, taskAttachmentsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with UUID: timestamp-uuid-originalname
    const timestamp = Date.now();
    const uuid = require('uuid').v4();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const filename = `${timestamp}-${uuid}-${basename}${ext}`;
    cb(null, filename);
  }
});

// Configure storage for chat attachments
const chatAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, chatAttachmentsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with UUID: timestamp-uuid-originalname
    const timestamp = Date.now();
    const uuid = require('uuid').v4();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const filename = `${timestamp}-${uuid}-${basename}${ext}`;
    cb(null, filename);
  }
});

// File filter - only allow images (for avatars)
const imageFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'));
  }
};

// File filter - allow common file types (for attachments)
const attachmentFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    // Videos
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
    'video/mpeg',
    // Audio
    'audio/webm',
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Please upload images, videos, audio, PDFs, or common document formats.'));
  }
};

// Create multer upload instance for avatars
export const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
  }
});

// Create multer upload instance for general attachments (default export)
const upload = multer({
  storage: attachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  }
});

// Create multer upload instance for task attachments
export const uploadTaskAttachment = multer({
  storage: taskAttachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size for tasks
  }
});

// Create multer upload instance for chat attachments
export const uploadChatAttachment = multer({
  storage: chatAttachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size for chat (to support videos)
  }
});

// Configure storage for support ticket attachments
const supportAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, supportAttachmentsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const uuid = require('uuid').v4();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${timestamp}-${uuid}-${basename}${ext}`);
  }
});

export const uploadSupportAttachment = multer({
  storage: supportAttachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  }
});

export default upload;
