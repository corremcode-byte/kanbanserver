import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  PERSONAL_FILES_DIR,
  PERSONAL_FILES_MAX_FILE_BYTES,
  PERSONAL_FILES_ALLOWED_MIME_TYPES
} from '../config/personalFiles';
import {
  SHARED_FILES_DIR,
  SHARED_FILES_MAX_FILE_BYTES,
  SHARED_FILES_ALLOWED_MIME_TYPES
} from '../config/sharedFiles';

// Create uploads directories if they don't exist
const avatarsDir = path.join(__dirname, '../../uploads/avatars');
const attachmentsDir = path.join(__dirname, '../../uploads/attachments');
const taskAttachmentsDir = path.join(__dirname, '../../uploads/task-attachments');
const chatAttachmentsDir = path.join(__dirname, '../../uploads/chat-attachments');
const supportAttachmentsDir = path.join(__dirname, '../../uploads/support-attachments');
const noteAttachmentsDir = path.join(__dirname, '../../uploads/note-attachments');

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

if (!fs.existsSync(noteAttachmentsDir)) {
  fs.mkdirSync(noteAttachmentsDir, { recursive: true });
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
//
// Exported so uploadController.ts can reuse the exact same allowlist to
// validate the client-declared `originalMimeType` field of an ENCRYPTED chat
// upload — the wire bytes of an encrypted attachment are opaque ciphertext
// (always application/octet-stream), so this filter can no longer content-sniff
// them; the real MIME type check for those uploads happens in the controller
// against this same list instead (see uploadChatAttachment).
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
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
  // Archives
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/x-compressed',
  'application/octet-stream',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
];

const attachmentFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Check exact match OR prefix match (handles codec variants like audio/webm;codecs=opus)
  const baseType = file.mimetype.split(';')[0].trim();
  if (ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.mimetype) || ALLOWED_ATTACHMENT_MIME_TYPES.includes(baseType)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Please upload images, videos, audio, PDFs, documents, or archives (zip, rar, 7z).'));
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
    fileSize: 500 * 1024 * 1024, // 500MB max file size for chat (to support videos)
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

// Configure storage for note attachments
const noteAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, noteAttachmentsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const uuid = require('uuid').v4();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${timestamp}-${uuid}-${basename}${ext}`);
  }
});

export const uploadNoteAttachment = multer({
  storage: noteAttachmentStorage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB, matching task attachments
  }
});

export default upload;

// ── Personal Files ──────────────────────────────────────────────────────────
// A DEDICATED multer instance for the Personal Files module. Deliberately kept
// separate from every instance above (avatar/attachment/task/chat/support) so
// Personal Files limits and its allow-list can be tuned without any risk of
// changing existing upload behaviour.
//
// Physical storage is FLAT — the logical folder tree lives only in MongoDB. The
// physical filename is generated server-side from a UUID and NEVER derived from
// client input, so a malicious `originalname` (e.g. "../../etc/passwd") cannot
// influence where the file lands. The user-visible name is stored (encrypted) in
// the database instead.

if (!fs.existsSync(PERSONAL_FILES_DIR)) {
  fs.mkdirSync(PERSONAL_FILES_DIR, { recursive: true });
}

const personalFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PERSONAL_FILES_DIR);
  },
  filename: (req, file, cb) => {
    // `path.extname` on untrusted input is only used to keep a convenient suffix;
    // it is sanitised to a short alphanumeric extension so nothing from the client
    // can introduce a separator, a traversal sequence or a second extension.
    const rawExt = path.extname(file.originalname || '');
    const safeExt = /^\.[A-Za-z0-9]{1,12}$/.test(rawExt) ? rawExt.toLowerCase() : '';
    const uuid = require('uuid').v4();
    cb(null, `${Date.now()}-${uuid}${safeExt}`);
  }
});

const personalFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const baseType = (file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (
    PERSONAL_FILES_ALLOWED_MIME_TYPES.includes(file.mimetype) ||
    PERSONAL_FILES_ALLOWED_MIME_TYPES.includes(baseType)
  ) {
    cb(null, true);
  } else {
    cb(new Error('This file type is not supported.'));
  }
};

export const uploadPersonalFile = multer({
  storage: personalFileStorage,
  fileFilter: personalFileFilter,
  limits: {
    fileSize: PERSONAL_FILES_MAX_FILE_BYTES,
    files: 1
  }
});

// ── Shared Files ────────────────────────────────────────────────────────────
// A DEDICATED multer instance for the Shared Files module, separate from every
// instance above INCLUDING uploadPersonalFile: the two modules have different
// storage directories (uploads/shared-files vs uploads/personal-files), separate
// quotas and independently tunable allow-lists. Nothing here is shared with the
// Personal Files instance, so neither module's upload policy can drift into the
// other's.
//
// Same hardening as Personal Files: flat physical storage, a server-generated
// UUID filename, and a sanitised extension — the client's `originalname` never
// influences where bytes land.

if (!fs.existsSync(SHARED_FILES_DIR)) {
  fs.mkdirSync(SHARED_FILES_DIR, { recursive: true });
}

const sharedFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, SHARED_FILES_DIR);
  },
  filename: (req, file, cb) => {
    const rawExt = path.extname(file.originalname || '');
    const safeExt = /^\.[A-Za-z0-9]{1,12}$/.test(rawExt) ? rawExt.toLowerCase() : '';
    const uuid = require('uuid').v4();
    cb(null, `${Date.now()}-${uuid}${safeExt}`);
  }
});

const sharedFileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const baseType = (file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (
    SHARED_FILES_ALLOWED_MIME_TYPES.includes(file.mimetype) ||
    SHARED_FILES_ALLOWED_MIME_TYPES.includes(baseType)
  ) {
    cb(null, true);
  } else {
    cb(new Error('This file type is not supported.'));
  }
};

export const uploadSharedFile = multer({
  storage: sharedFileStorage,
  fileFilter: sharedFileFilter,
  limits: {
    fileSize: SHARED_FILES_MAX_FILE_BYTES,
    files: 1
  }
});
