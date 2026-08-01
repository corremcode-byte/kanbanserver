import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { DataDeletionConfig } from '../models/DataDeletion';
import {
  User,
  Project,
  Task,
  ProjectInvitation,
  ProjectPermission,
  TaskTimeLog,
  AuditLog,
  Notification,
  Note,
} from '../models';
import TaskMessage from '../models/TaskMessage';
import SupportTicket from '../models/SupportTicket';
import { ChatGroup } from '../models/ChatGroup';
import { Message } from '../models/Message';

const CONFIRMATION_PHRASE = 'DELETE ALL DATA';

async function getConfig() {
  return DataDeletionConfig.findOne({ singletonKey: 'global' }).select('+passwordHash');
}

// GET /api/data-deletion/status — super admin only
export async function getDataDeletionStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const config = await getConfig();
    successResponse(res, 'Delete All Data status retrieved', { hasPassword: !!config });
  } catch (error) {
    logger.error('Error fetching data deletion status:', error);
    internalServerErrorResponse(res, 'Failed to retrieve status');
  }
}

// POST /api/data-deletion/password — super admin only, first-time setup only
export async function setDataDeletionPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { newPassword, confirmPassword } = req.body as { newPassword?: string; confirmPassword?: string };

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    errorResponse(res, 'Password must be at least 8 characters long', 400);
    return;
  }

  if (newPassword !== confirmPassword) {
    errorResponse(res, 'Passwords do not match', 400);
    return;
  }

  try {
    const existing = await getConfig();
    if (existing) {
      errorResponse(res, 'Delete All Data password has already been set', 409);
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await DataDeletionConfig.create({
      singletonKey: 'global',
      passwordHash,
      setBy: req.user?._id,
    });

    successResponse(res, 'Delete All Data password created successfully');
  } catch (error) {
    logger.error('Error setting data deletion password:', error);
    internalServerErrorResponse(res, 'Failed to set password');
  }
}

// POST /api/data-deletion/verify-password — super admin only
export async function verifyDataDeletionPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { password } = req.body as { password?: string };

  if (!password || typeof password !== 'string') {
    successResponse(res, 'Verification result', { valid: false });
    return;
  }

  try {
    const config = await getConfig();
    if (!config) {
      errorResponse(res, 'Delete All Data password has not been set up yet', 404);
      return;
    }

    const valid = await bcrypt.compare(password, config.passwordHash);
    successResponse(res, 'Verification result', { valid });
  } catch (error) {
    logger.error('Error verifying data deletion password:', error);
    internalServerErrorResponse(res, 'Failed to verify password');
  }
}

// Deletes every file inside dirPath except any whose basename is in keepFilenames.
// Missing directories are ignored — not every install has every attachment folder yet.
function emptyDirExcept(dirPath: string, keepFilenames: string[] = []): void {
  if (!fs.existsSync(dirPath)) return;
  const keep = new Set(keepFilenames);
  for (const entry of fs.readdirSync(dirPath)) {
    if (keep.has(entry)) continue;
    const entryPath = path.join(dirPath, entry);
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (error) {
      logger.error(`Failed to remove ${entryPath} during data wipe:`, error);
    }
  }
}

// POST /api/data-deletion/execute — super admin only
// Requires the Delete All Data password AND the exact confirmation phrase.
// Wipes all content/user data, preserving only the acting Super Admin's own
// User document, SystemSettings, and this feature's own DataDeletionConfig.
export async function executeDataWipe(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { password, confirmationPhrase } = req.body as { password?: string; confirmationPhrase?: string };

  if (!req.user?._id) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  if (confirmationPhrase !== CONFIRMATION_PHRASE) {
    errorResponse(res, `You must type "${CONFIRMATION_PHRASE}" exactly to confirm`, 400);
    return;
  }

  if (!password || typeof password !== 'string') {
    errorResponse(res, 'Delete All Data password is required', 400);
    return;
  }

  try {
    const config = await getConfig();
    if (!config) {
      errorResponse(res, 'Delete All Data password has not been set up yet', 404);
      return;
    }

    const validPassword = await bcrypt.compare(password, config.passwordHash);
    if (!validPassword) {
      errorResponse(res, 'Incorrect Delete All Data password', 401);
      return;
    }

    const currentUserId = req.user._id;

    await Promise.all([
      Task.deleteMany({}),
      Project.deleteMany({}),
      ProjectInvitation.deleteMany({}),
      ProjectPermission.deleteMany({}),
      TaskTimeLog.deleteMany({}),
      TaskMessage.deleteMany({}),
      Note.deleteMany({}),
      Notification.deleteMany({}),
      ChatGroup.deleteMany({}),
      Message.deleteMany({}),
      SupportTicket.deleteMany({}),
      AuditLog.deleteMany({}),
    ]);

    await User.deleteMany({ _id: { $ne: currentUserId } });

    // Remove orphaned uploaded files belonging to the now-deleted documents.
    // Avatars are kept for the surviving Super Admin (parsed from their own photoURL).
    const uploadsRoot = path.join(__dirname, '../../uploads');
    emptyDirExcept(path.join(uploadsRoot, 'attachments'));
    emptyDirExcept(path.join(uploadsRoot, 'task-attachments'));
    emptyDirExcept(path.join(uploadsRoot, 'chat-attachments'));
    emptyDirExcept(path.join(uploadsRoot, 'support-attachments'));

    const survivingAdmin = await User.findById(currentUserId).select('photoURL');
    const keepAvatarFilenames = survivingAdmin?.photoURL?.startsWith('/uploads/avatars/')
      ? [path.basename(survivingAdmin.photoURL)]
      : [];
    emptyDirExcept(path.join(uploadsRoot, 'avatars'), keepAvatarFilenames);

    logger.info(`Delete All Data executed by super admin ${currentUserId}`);
    successResponse(res, 'All application data has been deleted');
  } catch (error) {
    logger.error('Error executing data wipe:', error);
    internalServerErrorResponse(res, 'Failed to delete all data');
  }
}
