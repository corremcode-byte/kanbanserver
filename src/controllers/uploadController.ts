import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import Task from '../models/Task';
import Project from '../models/Project';
import Note from '../models/Note';
import { ChatGroup } from '../models/ChatGroup';
import { AuthenticatedRequest } from '../middleware/auth';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { encryptField, decryptField, decryptProjectFields } from '../utils/fieldEncryption';
import { compressUploadedImage } from '../utils/imageCompression';
import { ALLOWED_ATTACHMENT_MIME_TYPES } from '../middleware/upload';
import { isValidSealedKeyEntryShape, memberKeysMatchGroupMembers } from '../utils/groupKeyValidation';

/**
 * Validates the multipart-form metadata fields a client sends alongside an
 * ENCRYPTED (true E2EE) attachment upload — shared by chat, task, subtask, and
 * note uploads, all of which use the identical field set. The server never
 * sees the plaintext file; these are just the client's own declarations about
 * it (filename/mimetype/size), used for display and validated against the
 * existing MIME allowlist. Returns either the parsed metadata or an error
 * message to send back as a 400.
 */
interface EncryptedAttachmentMetadata {
  attachmentId: string;
  originalMimeType: string;
  originalFileName: string;
  originalFileSize: number;
  containerVersion: number;
  chunkSize: number;
  encryptionAlgorithm: string;
}

// NOTE: intentionally NOT a discriminated union ({ok:true,...}|{ok:false,...}).
// This project builds with strictNullChecks/strict OFF (see tsconfig.json),
// under which TS's control-flow narrowing on a boolean-literal discriminant
// does not reliably narrow away the other union member (verified: the same
// pattern narrows correctly with strictNullChecks on, and fails identically
// with it off, in isolation — a real behavior difference, not a typo here).
// A flat shape with a nullable `error` field sidesteps that entirely, and
// matches this file's/module's existing loose (`any`-heavy) typing style.
interface ParsedEncryptedAttachmentMetadata {
  error: string | null;
  meta: EncryptedAttachmentMetadata | null;
}

function parseEncryptedAttachmentMetadata(
  body: any,
  fallbackFileName: string
): ParsedEncryptedAttachmentMetadata {
  const attachmentId = typeof body?.attachmentId === 'string' ? body.attachmentId : '';
  const originalMimeType = typeof body?.originalMimeType === 'string' ? body.originalMimeType : '';
  const originalFileName = typeof body?.originalFileName === 'string' && body.originalFileName
    ? body.originalFileName
    : fallbackFileName;
  const originalFileSize = parseInt(body?.originalFileSize, 10);
  const containerVersion = parseInt(body?.containerVersion, 10);
  const chunkSize = parseInt(body?.chunkSize, 10);
  const encryptionAlgorithm = typeof body?.encryptionAlgorithm === 'string' ? body.encryptionAlgorithm : 'AES-256-GCM';

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(attachmentId)) {
    return { error: 'Invalid or missing attachmentId for encrypted upload', meta: null };
  }
  const baseOriginalMime = originalMimeType.split(';')[0].trim();
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(originalMimeType) && !ALLOWED_ATTACHMENT_MIME_TYPES.includes(baseOriginalMime)) {
    return { error: 'Invalid or missing originalMimeType for encrypted upload', meta: null };
  }
  if (!Number.isFinite(originalFileSize) || originalFileSize < 0) {
    return { error: 'Invalid or missing originalFileSize for encrypted upload', meta: null };
  }
  if (!Number.isFinite(containerVersion) || containerVersion < 1) {
    return { error: 'Invalid or missing containerVersion for encrypted upload', meta: null };
  }
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    return { error: 'Invalid or missing chunkSize for encrypted upload', meta: null };
  }

  return {
    error: null,
    meta: { attachmentId, originalMimeType, originalFileName, originalFileSize, containerVersion, chunkSize, encryptionAlgorithm }
  };
}

/**
 * Parses+validates the `attachmentKeys` multipart field (a JSON-stringified
 * array of sealed per-recipient AES-key copies) that travels alongside an
 * encrypted task/subtask/note upload — there's no separate "create parent"
 * JSON call the way chat's sendMessage has, so this rides along with the file
 * itself. Rejects (returns ok:false) if the shape is malformed, any entry's
 * userId isn't a current recipient, or (for an encrypted attachment) there are
 * zero entries at all — a silently undecryptable attachment, including by its
 * own uploader, is worse than a rejected upload.
 */
interface ParsedAttachmentKeys {
  error: string | null;
  entries: { attachmentId: string; userId: string; encryptedKey: string; nonce: string; senderPublicKey: string }[];
}

// Same non-discriminated-union shape as ParsedEncryptedAttachmentMetadata
// above, for the same reason (this project builds with strictNullChecks off).
function parseAndValidateAttachmentKeys(
  rawField: unknown,
  attachmentId: string,
  currentRecipientIds: string[]
): ParsedAttachmentKeys {
  let parsed: unknown;
  try {
    parsed = typeof rawField === 'string' && rawField ? JSON.parse(rawField) : [];
  } catch {
    return { error: 'attachmentKeys must be valid JSON', entries: [] };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'attachmentKeys must be an array', entries: [] };
  }
  if (!parsed.every((k: any) => isValidSealedKeyEntryShape(k))) {
    return { error: 'One or more attachmentKeys entries are malformed', entries: [] };
  }
  if (!memberKeysMatchGroupMembers(parsed as any[], currentRecipientIds)) {
    return { error: 'attachmentKeys may only be sealed to current recipients', entries: [] };
  }
  if (parsed.length === 0) {
    return { error: 'Encrypted attachments must include at least one attachmentKeys entry', entries: [] };
  }
  const entries = (parsed as any[]).map((k) => ({
    attachmentId,
    userId: k.userId as string,
    encryptedKey: k.encryptedKey as string,
    nonce: k.nonce as string,
    senderPublicKey: k.senderPublicKey as string
  }));
  return { error: null, entries };
}

/**
 * The full set of userIds who currently have access to a project — and thus
 * are the valid recipient set for E2EE-sealing a task/subtask attachment's
 * AES key. Deliberately includes `owners[]` (a newer co-owner array) alongside
 * the legacy `ownerId`, `members[]`, and `managers[]` — see
 * projectsController.ts::getProjectMemberKeys, which uses the identical union.
 */
function getProjectRecipientIds(project: any): string[] {
  const ids = new Set<string>();
  if (project.ownerId) ids.add(project.ownerId.toString());
  (project.owners || []).forEach((o: any) => ids.add(o.toString()));
  (project.members || []).forEach((m: any) => ids.add(m.toString()));
  (project.managers || []).forEach((m: any) => ids.add(m.toString()));
  return Array.from(ids);
}

/**
 * Get the base URL for file serving
 */
const getBaseUrl = (req: Request): string => {
  // Use environment variable if set (prefer FILE_SERVE_URL, fallback to API_URL)
  if (process.env.FILE_SERVE_URL) {
    return process.env.FILE_SERVE_URL;
  }
  if (process.env.API_URL) {
    return process.env.API_URL;
  }
  // Construct from request - keep the port for local development
  const protocol = req.protocol;
  const host = req.get('host') || 'localhost:3001';
  return `${protocol}://${host}`;
};

/**
 * Upload file to Firebase Storage and attach to task
 */
export const uploadTaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;

    logger.info(`📤 Upload request received for task: ${taskId}`);
    logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
    logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);

    if (!req.file) {
      logger.error('❌ Upload failed: No file uploaded');
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    // Validate taskId
    if (!taskId || taskId === 'undefined' || taskId === 'null') {
      logger.error(`❌ Upload failed: Invalid task ID - ${taskId}`);
      res.status(400).json({ success: false, message: 'Invalid task ID' });
      return;
    }

    // Find task and verify user has permission
    logger.info(`🔍 Looking up task: ${taskId}`);
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      logger.error(`❌ Upload failed: Task not found - ${taskId}`);
      res.status(404).json({ success: false, message: `Task not found with ID: ${taskId}` });
      return;
    }
    // task is saved again below (adding the attachment), so its title is decrypted
    // into a local var rather than mutated in place — mutating in place here would
    // persist the decrypted plaintext back over the ciphertext on save.
    logger.info(`✅ Task found: ${decryptField(task.title, taskId)}`);

    const project = await Project.findById(task.projectId);
    if (!project) {
      logger.error(`❌ Upload failed: Project not found`);
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }
    decryptProjectFields(project as any);
    logger.info(`✅ Project found: ${project.name}`);

    // Check if user is owner, manager, or member of the project
    if (!req.user || !req.user._id) {
      logger.error('❌ Upload failed: User not authenticated');
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    // isOwner/isCoOwner also cover project.owners[] — a pre-existing gap in this
    // check (only ownerId/members/managers were tested) that must be fixed now:
    // the new project member-keys endpoint (projectsController.ts::getProjectMemberKeys)
    // correctly includes owners[] as recipients, so a co-owner must also be able
    // to actually pass this upload/access gate, or they'd get sealed keys for
    // attachments they can never upload/view themselves.
    const isOwner = project.ownerId.toString() === userId;
    const isCoOwner = project.owners?.some((o: any) => o.toString() === userId);
    const isMember = project.members.some((m: any) => m.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);
    const currentRecipientIds = getProjectRecipientIds(project);

    if (!isOwner && !isCoOwner && !isMember && !isManager) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const file = req.file;

    // Client declares whether `file`'s bytes are an opaque, client-side
    // AES-256-GCM encrypted container rather than a real, server-decodable
    // file — see attachmentEncryptionService.ts on the client. The server
    // NEVER attempts to decrypt this; it only stores/serves it as-is.
    const isEncrypted = req.body?.isEncrypted === 'true' || req.body?.isEncrypted === true;

    let attachment: Record<string, unknown>;
    let attachmentKeyEntries: { attachmentId: string; userId: string; encryptedKey: string; nonce: string; senderPublicKey: string }[] = [];

    if (isEncrypted) {
      const parsed = parseEncryptedAttachmentMetadata(req.body, file.originalname);
      if (parsed.error) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }
      const keysResult = parseAndValidateAttachmentKeys(req.body?.attachmentKeys, parsed.meta!.attachmentId, currentRecipientIds);
      if (keysResult.error) {
        res.status(400).json({ success: false, message: keysResult.error });
        return;
      }
      attachmentKeyEntries = keysResult.entries;

      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;
      logger.info(`📦 Encrypted task file saved to disk: ${file.path} (attachmentId=${parsed.meta.attachmentId})`);

      attachment = {
        id: parsed.meta.attachmentId,
        attachmentId: parsed.meta.attachmentId,
        name: parsed.meta.originalFileName,
        url: publicUrl,
        type: file.mimetype, // application/octet-stream — the container's own wire type
        size: file.size, // encrypted container size
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: true,
        encryptionVersion: 1,
        encryptionAlgorithm: parsed.meta.encryptionAlgorithm,
        containerVersion: parsed.meta.containerVersion,
        chunkSize: parsed.meta.chunkSize,
        originalMimeType: parsed.meta.originalMimeType,
        originalFileSize: parsed.meta.originalFileSize
      };
    } else {
      // Legacy plaintext path — completely unchanged behavior.
      const fileId = uuidv4();
      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;

      logger.info(`📦 File saved to disk: ${file.path}`);
      logger.info(`🔗 Public URL: ${publicUrl}`);

      attachment = {
        id: fileId,
        name: file.originalname,
        url: publicUrl,
        type: file.mimetype,
        size: file.size,
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: false,
        encryptionVersion: 0
      };
    }

    // `attachment` (plaintext url) is what's returned to the client below; a
    // separate copy with the url encrypted is what's persisted — this avoids
    // ever needing to decrypt-after-save on the response object.
    task.attachments.push({ ...attachment, url: encryptField(attachment.url as string, taskId) } as any);
    if (attachmentKeyEntries.length > 0) {
      task.attachmentKeys = [...(task.attachmentKeys || []), ...(attachmentKeyEntries as any)];
    }
    await task.save();

    logger.info(`✅ File uploaded successfully: ${file.filename}`);
    res.json({
      success: true,
      message: 'File uploaded successfully',
      attachment
    });
  } catch (error) {
    logger.error('❌ Error in uploadTaskAttachment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Server error';
    logger.error(`Error details: ${errorMessage}`);
    res.status(500).json({
      success: false,
      message: `Upload failed: ${errorMessage}`
    });
  }
};

/**
 * Delete attachment from task and Firebase Storage
 */
export const deleteTaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, attachmentId } = req.params;

    // Find task
    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const project = await Project.findById(task.projectId);
    if (!project) {
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }

    // Check permissions
    const userId = req.user._id.toString();
    const isOwner = project.ownerId.toString() === userId;
    const isCoOwner = project.owners?.some((o: any) => o.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);

    // Find attachment
    const attachment = task.attachments.find((a: any) => a.id === attachmentId);
    if (!attachment) {
      res.status(404).json({ success: false, message: 'Attachment not found' });
      return;
    }

    // Only owner, manager, or the uploader can delete
    const isUploader = attachment.uploadedBy.toString() === userId;
    if (!isOwner && !isCoOwner && !isManager && !isUploader) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    // Delete from filesystem
    try {
      // url is encrypted at rest — decrypt into a local var before splitting it,
      // since base64 ciphertext legitimately contains '/' characters and would
      // otherwise silently produce a bogus filename.
      const decryptedUrl = decryptField(attachment.url, taskId) || '';
      const urlParts = decryptedUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      const filePath = path.join(process.cwd(), 'uploads', 'task-attachments', filename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Deleted file from storage: ${filePath}`);
      } else {
        logger.warn(`File not found in storage: ${filePath}`);
      }
    } catch (error) {
      logger.warn(`Error deleting file from storage:`, error);
      // Continue even if file doesn't exist
    }

    // Remove from task attachments (and any sealed keys for it, if it was encrypted)
    task.attachments = task.attachments.filter((a: any) => a.id !== attachmentId);
    if (task.attachmentKeys?.length) {
      task.attachmentKeys = task.attachmentKeys.filter((k: any) => k.attachmentId !== (attachment as any).attachmentId);
    }
    await task.save();

    res.json({
      success: true,
      message: 'Attachment deleted successfully'
    });
  } catch (error) {
    logger.error('Error in deleteTaskAttachment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Get all attachments for a task
 */
export const getTaskAttachments = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId).populate('attachments.uploadedBy', 'name email avatar').populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    // Bundled fix: this endpoint previously had NO project-membership check at
    // all (relying solely on the global `authenticate` middleware), unlike its
    // sibling upload/delete functions — meaning any logged-in user could list
    // any task's attachment metadata by taskId alone. Now consistent with the
    // rest of this file.
    const userId = (req as any).user?._id?.toString() || '';
    const project = await Project.findById(task.projectId);
    if (!project) {
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }
    const currentRecipientIds = getProjectRecipientIds(project);
    if (!currentRecipientIds.includes(userId)) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    task.attachments.forEach((a: any) => {
      if (a.url) a.url = decryptField(a.url, taskId);
    });

    const myAttachmentKeys = (task.attachmentKeys || []).filter((k: any) => k.userId?.toString() === userId);

    res.json({
      success: true,
      attachments: task.attachments,
      attachmentKeys: myAttachmentKeys
    });
  } catch (error) {
    logger.error('Error in getTaskAttachments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Upload attachment to a specific subtask
 */
export const uploadSubtaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, subtaskId } = req.params;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    const project = await Project.findById(task.projectId);
    if (!project) {
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }

    if (!req.user?._id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    const isOwner = project.ownerId.toString() === userId;
    const isCoOwner = project.owners?.some((o: any) => o.toString() === userId);
    const isMember = project.members.some((m: any) => m.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);
    const currentRecipientIds = getProjectRecipientIds(project);
    if (!isOwner && !isCoOwner && !isMember && !isManager) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const subtask = (task.subtasks as any[]).find((s) => s.id === subtaskId);
    if (!subtask) {
      res.status(404).json({ success: false, message: 'Subtask not found' });
      return;
    }

    const file = req.file;
    const isEncrypted = req.body?.isEncrypted === 'true' || req.body?.isEncrypted === true;

    let attachment: Record<string, unknown>;
    let attachmentKeyEntries: { attachmentId: string; userId: string; encryptedKey: string; nonce: string; senderPublicKey: string }[] = [];

    if (isEncrypted) {
      const parsed = parseEncryptedAttachmentMetadata(req.body, file.originalname);
      if (parsed.error) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }
      const keysResult = parseAndValidateAttachmentKeys(req.body?.attachmentKeys, parsed.meta!.attachmentId, currentRecipientIds);
      if (keysResult.error) {
        res.status(400).json({ success: false, message: keysResult.error });
        return;
      }
      attachmentKeyEntries = keysResult.entries;

      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;
      logger.info(`📦 Encrypted subtask file saved to disk: ${file.path} (attachmentId=${parsed.meta.attachmentId})`);

      attachment = {
        id: parsed.meta.attachmentId,
        attachmentId: parsed.meta.attachmentId,
        name: parsed.meta.originalFileName,
        url: publicUrl,
        type: file.mimetype,
        size: file.size,
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: true,
        encryptionVersion: 1,
        encryptionAlgorithm: parsed.meta.encryptionAlgorithm,
        containerVersion: parsed.meta.containerVersion,
        chunkSize: parsed.meta.chunkSize,
        originalMimeType: parsed.meta.originalMimeType,
        originalFileSize: parsed.meta.originalFileSize
      };
    } else {
      const fileId = uuidv4();
      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/task-attachments/${file.filename}`;

      attachment = {
        id: fileId,
        name: file.originalname,
        url: publicUrl,
        type: file.mimetype,
        size: file.size,
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: false,
        encryptionVersion: 0
      };
    }

    // attachment (plaintext url) is returned to the client below; the encrypted
    // copy pushed onto the subtask is keyed by the parent TASK's id, not the
    // subtask's own id — same convention as subtask titles/comments.
    if (!subtask.attachments) subtask.attachments = [];
    subtask.attachments.push({ ...attachment, url: encryptField(attachment.url as string, taskId) });
    if (attachmentKeyEntries.length > 0) {
      task.attachmentKeys = [...(task.attachmentKeys || []), ...(attachmentKeyEntries as any)];
    }
    task.markModified('subtasks');
    await task.save();

    logger.info(`✅ Subtask attachment uploaded: ${file.filename}`);
    res.json({ success: true, message: 'File uploaded successfully', attachment });
  } catch (error) {
    logger.error('❌ Error in uploadSubtaskAttachment:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

/**
 * Delete attachment from a subtask
 */
export const deleteSubtaskAttachment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId, subtaskId, attachmentId } = req.params;

    const task = await Task.findById(taskId).populate('projectId');
    if (!task) {
      res.status(404).json({ success: false, message: 'Task not found' });
      return;
    }

    // Bundled fix: this endpoint previously had NO project-membership/permission
    // check at all beyond the global `authenticate` middleware, unlike every
    // other task-attachment function in this file — any logged-in user could
    // delete any subtask attachment on any task. Now consistent.
    const project = await Project.findById(task.projectId);
    if (!project) {
      res.status(404).json({ success: false, message: 'Project not found' });
      return;
    }
    const userId = (req as any).user?._id?.toString() || '';
    const isOwner = project.ownerId.toString() === userId;
    const isCoOwner = project.owners?.some((o: any) => o.toString() === userId);
    const isManager = project.managers?.some((m: any) => m.toString() === userId);

    const subtask = (task.subtasks as any[]).find((s) => s.id === subtaskId);
    if (!subtask) {
      res.status(404).json({ success: false, message: 'Subtask not found' });
      return;
    }

    const attachment = (subtask.attachments || []).find((a: any) => a.id === attachmentId);
    if (!attachment) {
      res.status(404).json({ success: false, message: 'Attachment not found' });
      return;
    }

    const isUploader = attachment.uploadedBy?.toString() === userId;
    if (!isOwner && !isCoOwner && !isManager && !isUploader) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    // Delete file from disk — url is encrypted at rest (keyed by the parent task's
    // id), decrypt before splitting since base64 ciphertext contains '/' characters.
    try {
      const decryptedUrl = decryptField(attachment.url, taskId) || '';
      const filename = decryptedUrl.split('/').pop();
      const filePath = path.join(process.cwd(), 'uploads', 'task-attachments', filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* continue if file missing */ }

    subtask.attachments = (subtask.attachments || []).filter((a: any) => a.id !== attachmentId);
    if (task.attachmentKeys?.length) {
      task.attachmentKeys = task.attachmentKeys.filter((k: any) => k.attachmentId !== (attachment as any).attachmentId);
    }
    task.markModified('subtasks');
    await task.save();

    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (error) {
    logger.error('Error in deleteSubtaskAttachment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Upload file to VPS storage for chat attachment
 */
export const uploadChatAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { groupId } = req.params;

    logger.info(`📤 Chat upload request received for group: ${groupId}`);
    logger.info(`📎 File: ${req.file ? req.file.originalname : 'No file'}`);
    logger.info(`👤 User: ${req.user ? req.user._id : 'No user'}`);

    if (!req.file) {
      logger.error('❌ Upload failed: No file uploaded');
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    // Validate groupId
    if (!groupId || groupId === 'undefined' || groupId === 'null') {
      logger.error(`❌ Upload failed: Invalid group ID - ${groupId}`);
      res.status(400).json({ success: false, message: 'Invalid group ID' });
      return;
    }

    // Find group and verify user is a member
    logger.info(`🔍 Looking up chat group: ${groupId}`);
    const chatGroup = await ChatGroup.findOne({
      _id: groupId,
      members: req.user?._id,
      isActive: true
    });

    if (!chatGroup) {
      logger.error(`❌ Upload failed: Group not found or access denied - ${groupId}`);
      res.status(403).json({ success: false, message: 'Not authorized to upload to this group' });
      return;
    }
    logger.info(`✅ Chat group found: ${chatGroup.name}`);

    const file = req.file;

    // Client declares whether `file`'s bytes are an opaque, client-side
    // AES-256-GCM encrypted container (true E2EE — see
    // attachmentEncryptionService.ts on the client) rather than a real,
    // server-decodable file. The server NEVER attempts to decrypt this; it only
    // stores/serves it as-is and passes through the client's own declared
    // metadata about the plaintext it can't see.
    const isEncrypted = req.body?.isEncrypted === 'true' || req.body?.isEncrypted === true;

    let attachment: Record<string, unknown>;

    if (isEncrypted) {
      // Ciphertext is not a decodable image — compressUploadedImage would no-op
      // on an application/octet-stream mimetype anyway, but skip it explicitly
      // so intent is clear and this stays correct even if that allowlist changes.
      const attachmentId = typeof req.body?.attachmentId === 'string' ? req.body.attachmentId : '';
      const originalMimeType = typeof req.body?.originalMimeType === 'string' ? req.body.originalMimeType : '';
      const originalFileName = typeof req.body?.originalFileName === 'string' && req.body.originalFileName
        ? req.body.originalFileName
        : file.originalname;
      const originalFileSize = parseInt(req.body?.originalFileSize, 10);
      const containerVersion = parseInt(req.body?.containerVersion, 10);
      const chunkSize = parseInt(req.body?.chunkSize, 10);
      const encryptionAlgorithm = typeof req.body?.encryptionAlgorithm === 'string' ? req.body.encryptionAlgorithm : 'AES-256-GCM';

      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(attachmentId)) {
        res.status(400).json({ success: false, message: 'Invalid or missing attachmentId for encrypted upload' });
        return;
      }
      const baseOriginalMime = originalMimeType.split(';')[0].trim();
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(originalMimeType) && !ALLOWED_ATTACHMENT_MIME_TYPES.includes(baseOriginalMime)) {
        res.status(400).json({ success: false, message: 'Invalid or missing originalMimeType for encrypted upload' });
        return;
      }
      if (!Number.isFinite(originalFileSize) || originalFileSize < 0) {
        res.status(400).json({ success: false, message: 'Invalid or missing originalFileSize for encrypted upload' });
        return;
      }
      if (!Number.isFinite(containerVersion) || containerVersion < 1) {
        res.status(400).json({ success: false, message: 'Invalid or missing containerVersion for encrypted upload' });
        return;
      }
      if (!Number.isFinite(chunkSize) || chunkSize < 1) {
        res.status(400).json({ success: false, message: 'Invalid or missing chunkSize for encrypted upload' });
        return;
      }

      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/chat-attachments/${file.filename}`;
      logger.info(`📦 Encrypted chat file saved to disk: ${file.path} (attachmentId=${attachmentId})`);

      attachment = {
        attachmentId,
        fileName: originalFileName,
        fileUrl: publicUrl,
        fileType: file.mimetype, // application/octet-stream — the container's own wire type
        fileSize: file.size, // encrypted container size
        mimeType: file.mimetype,
        isEncrypted: true,
        encryptionVersion: 1,
        encryptionAlgorithm,
        containerVersion,
        chunkSize,
        originalMimeType,
        originalFileSize
      };
    } else {
      // Legacy plaintext path — completely unchanged behavior.
      await compressUploadedImage(file);

      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/chat-attachments/${file.filename}`;

      logger.info(`📦 Chat file saved to disk: ${file.path}`);
      logger.info(`🔗 Public URL: ${publicUrl}`);

      attachment = {
        fileName: file.originalname,
        fileUrl: publicUrl,
        fileType: file.mimetype,
        fileSize: file.size,
        mimeType: file.mimetype,
        isEncrypted: false,
        encryptionVersion: 0
      };
    }

    // Optional client-supplied duration (seconds) for voice/audio/video attachments —
    // multer puts non-file multipart fields on req.body alongside the file.
    const parsedDuration = parseFloat(req.body?.duration);
    if (!isNaN(parsedDuration) && parsedDuration > 0) {
      attachment.duration = parsedDuration;
    }

    logger.info(`✅ Chat file uploaded successfully: ${file.filename}`);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      attachment
    });
  } catch (error) {
    logger.error('❌ Error in uploadChatAttachment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Server error';
    logger.error(`Error details: ${errorMessage}`);
    res.status(500).json({
      success: false,
      message: `Upload failed: ${errorMessage}`
    });
  }
};

/**
 * Upload file for a support ticket or reply
 */
export const uploadSupportAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const file = req.file;
    const baseUrl = getBaseUrl(req);
    const publicUrl = `${baseUrl}/uploads/support-attachments/${file.filename}`;

    const attachment = {
      id: uuidv4(),
      name: file.originalname,
      url: publicUrl,
      type: file.mimetype,
      size: file.size,
    };

    res.json({ success: true, attachment });
  } catch (error) {
    logger.error('Error in uploadSupportAttachment:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

/**
 * The full set of userIds who currently have access to a note — owner plus
 * every sharedWith entry — and thus the valid recipient set for E2EE-sealing
 * a note attachment's AES key. Mirrors getProjectRecipientIds above.
 */
function getNoteRecipientIds(note: any): string[] {
  const ids = new Set<string>();
  if (note.userId) ids.add(note.userId.toString());
  (note.sharedWith || []).forEach((s: any) => {
    const id = s.userId?.toString?.();
    if (id) ids.add(id);
  });
  return Array.from(ids);
}

/**
 * Upload file to VPS storage for a note attachment (true E2EE — see
 * attachmentEncryptionService.ts on the client — or legacy plaintext, same
 * isEncrypted branch pattern as chat/task uploads above).
 */
export const uploadNoteAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { noteId } = req.params;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }
    if (!req.user?._id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const note = await Note.findOne({
      _id: noteId,
      $or: [{ userId: req.user._id }, { 'sharedWith.userId': req.user._id }]
    });
    if (!note) {
      res.status(404).json({ success: false, message: 'Note not found' });
      return;
    }

    const userId = req.user._id.toString();
    const isOwner = note.userId.toString() === userId;
    const sharedEntry = (note.sharedWith || []).find((s: any) => s.userId?.toString() === userId);
    const canEdit = isOwner || sharedEntry?.permission === 'edit';
    if (!canEdit) {
      res.status(403).json({ success: false, message: 'You do not have permission to add attachments to this note' });
      return;
    }
    const currentRecipientIds = getNoteRecipientIds(note);

    const file = req.file;
    const isEncrypted = req.body?.isEncrypted === 'true' || req.body?.isEncrypted === true;

    let attachment: Record<string, unknown>;
    let attachmentKeyEntries: { attachmentId: string; userId: string; encryptedKey: string; nonce: string; senderPublicKey: string }[] = [];

    if (isEncrypted) {
      const parsed = parseEncryptedAttachmentMetadata(req.body, file.originalname);
      if (parsed.error) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }
      const keysResult = parseAndValidateAttachmentKeys(req.body?.attachmentKeys, parsed.meta!.attachmentId, currentRecipientIds);
      if (keysResult.error) {
        res.status(400).json({ success: false, message: keysResult.error });
        return;
      }
      attachmentKeyEntries = keysResult.entries;

      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/note-attachments/${file.filename}`;
      logger.info(`📦 Encrypted note file saved to disk: ${file.path} (attachmentId=${parsed.meta.attachmentId})`);

      attachment = {
        id: parsed.meta.attachmentId,
        attachmentId: parsed.meta.attachmentId,
        name: parsed.meta.originalFileName,
        url: publicUrl,
        type: file.mimetype,
        size: file.size,
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: true,
        encryptionVersion: 1,
        encryptionAlgorithm: parsed.meta.encryptionAlgorithm,
        containerVersion: parsed.meta.containerVersion,
        chunkSize: parsed.meta.chunkSize,
        originalMimeType: parsed.meta.originalMimeType,
        originalFileSize: parsed.meta.originalFileSize
      };
    } else {
      const baseUrl = getBaseUrl(req);
      const publicUrl = `${baseUrl}/uploads/note-attachments/${file.filename}`;

      attachment = {
        id: uuidv4(),
        name: file.originalname,
        url: publicUrl,
        type: file.mimetype,
        size: file.size,
        uploadedBy: new mongoose.Types.ObjectId(req.user._id),
        uploadedAt: new Date(),
        isEncrypted: false,
        encryptionVersion: 0
      };
    }

    const noteId_ = note._id.toString();
    if (!note.attachments) note.attachments = [];
    note.attachments.push({ ...attachment, url: encryptField(attachment.url as string, noteId_) } as any);
    if (attachmentKeyEntries.length > 0) {
      note.attachmentKeys = [...(note.attachmentKeys || []), ...(attachmentKeyEntries as any)];
    }
    await note.save();

    logger.info(`✅ Note attachment uploaded: ${file.filename}`);
    res.json({ success: true, message: 'File uploaded successfully', attachment });
  } catch (error) {
    logger.error('❌ Error in uploadNoteAttachment:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

/**
 * Get all attachments for a note (+ this requesting user's own sealed
 * attachment keys, filtered server-side — never another recipient's).
 */
export const getNoteAttachments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { noteId } = req.params;
    if (!req.user?._id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const note = await Note.findOne({
      _id: noteId,
      $or: [{ userId: req.user._id }, { 'sharedWith.userId': req.user._id }]
    }).populate('attachments.uploadedBy', 'name email avatar');
    if (!note) {
      res.status(404).json({ success: false, message: 'Note not found' });
      return;
    }

    const userId = req.user._id.toString();
    (note.attachments || []).forEach((a: any) => {
      if (a.url) a.url = decryptField(a.url, noteId);
    });
    const myAttachmentKeys = (note.attachmentKeys || []).filter((k: any) => k.userId?.toString() === userId);

    res.json({
      success: true,
      attachments: note.attachments || [],
      attachmentKeys: myAttachmentKeys
    });
  } catch (error) {
    logger.error('Error in getNoteAttachments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** Delete an attachment from a note. */
export const deleteNoteAttachment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { noteId, attachmentId } = req.params;
    if (!req.user?._id) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const note = await Note.findOne({
      _id: noteId,
      $or: [{ userId: req.user._id }, { 'sharedWith.userId': req.user._id }]
    });
    if (!note) {
      res.status(404).json({ success: false, message: 'Note not found' });
      return;
    }

    const userId = req.user._id.toString();
    const isOwner = note.userId.toString() === userId;
    const sharedEntry = (note.sharedWith || []).find((s: any) => s.userId?.toString() === userId);
    const canEdit = isOwner || sharedEntry?.permission === 'edit';
    if (!canEdit) {
      res.status(403).json({ success: false, message: 'You do not have permission to remove attachments from this note' });
      return;
    }

    const attachment = (note.attachments || []).find((a: any) => a.id === attachmentId);
    if (!attachment) {
      res.status(404).json({ success: false, message: 'Attachment not found' });
      return;
    }

    try {
      const decryptedUrl = decryptField(attachment.url, noteId) || '';
      const filename = decryptedUrl.split('/').pop();
      const filePath = path.join(process.cwd(), 'uploads', 'note-attachments', filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* continue if file missing */ }

    note.attachments = (note.attachments || []).filter((a: any) => a.id !== attachmentId);
    if (note.attachmentKeys?.length) {
      note.attachmentKeys = note.attachmentKeys.filter((k: any) => k.attachmentId !== (attachment as any).attachmentId);
    }
    await note.save();

    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (error) {
    logger.error('Error in deleteNoteAttachment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
