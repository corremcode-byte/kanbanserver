import { Router } from 'express';
import {
  createChatGroup,
  getUserChatGroups,
  getChatGroup,
  sendMessage,
  getGroupMessages,
  markMessageAsRead,
  editMessage,
  deleteMessage,
  toggleReaction,
  togglePin,
  toggleStar,
  addMembersToGroup,
  removeMemberFromGroup,
  updateChatGroup,
  deleteChatGroup,
  createOrGetPersonalChat,
  getOrCreateSelfChatGroup,
  superAdminGetAllUsers,
  superAdminGetUserChatGroups,
  superAdminGetGroupMessages
} from '../controllers/chatController';
import { uploadChatAttachment } from '../controllers/uploadController';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { checkPermission } from '../middleware/permissions';
import upload, { uploadChatAttachment as uploadChatMiddleware } from '../middleware/upload';
import { bucket } from '../config/firebase';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Debug endpoint to test Firebase Storage
router.get('/debug/storage', async (_req, res) => {
  try {
    // Try to write a test file
    const testFile = bucket.file('test.txt');
    await testFile.save('Hello Firebase!');
    await testFile.makePublic();
    const publicUrl = testFile.publicUrl();

    // Delete the test file
    await testFile.delete();

    res.json({
      success: true,
      bucketConfigured: !!bucket,
      bucketName: bucket?.name || 'Not configured',
      message: 'Firebase Storage is working!',
      testUrl: publicUrl
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      bucketConfigured: !!bucket,
      bucketName: bucket?.name || 'Not configured',
      message: 'Firebase Storage test failed',
      error: error.message
    });
  }
});

// Debug endpoint to test file upload without Firebase
router.post('/groups/:groupId/upload-test', upload.single('file'), (req, res) => {
  console.log('🧪 Test upload endpoint hit');
  console.log('File:', req.file ? req.file.originalname : 'No file');
  console.log('Group ID:', req.params.groupId);

  if (!req.file) {
    res.status(400).json({ message: 'No file received' });
    return;
  }

  res.json({
    success: true,
    message: 'File received successfully (test endpoint)',
    fileInfo: {
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
      bufferLength: req.file.buffer?.length
    }
  });
});

// Super Admin routes (must be before parameterized routes to avoid conflicts)
router.get('/superadmin/users', requireSuperAdmin, superAdminGetAllUsers);
router.get('/superadmin/users/:userId/groups', requireSuperAdmin, superAdminGetUserChatGroups);
router.get('/superadmin/groups/:groupId/messages', requireSuperAdmin, superAdminGetGroupMessages);

// Chat group routes
router.post('/groups', createChatGroup);
router.post('/personal', createOrGetPersonalChat);
router.get('/groups', getUserChatGroups);
router.get('/self-chat', getOrCreateSelfChatGroup); // Get or create "Message Yourself" group
router.get('/groups/:groupId', getChatGroup);
router.put('/groups/:groupId', updateChatGroup);
router.post('/groups/:groupId/members', addMembersToGroup);
router.delete('/groups/:groupId/members/:userId', removeMemberFromGroup);
router.delete('/groups/:groupId', deleteChatGroup);

// File upload route with error handling
router.post('/groups/:groupId/upload', (req, res, next) => {
  const handler = uploadChatMiddleware.single('file');
  handler(req, res, (err: any) => {
    if (err) {
      console.error('🚨 Multer error:', err);
      res.status(500).json({
        success: false,
        message: `File upload error: ${err.message}`
      });
      return;
    }
    next();
  });
}, uploadChatAttachment);

// Message routes
router.post('/messages', sendMessage);
router.get('/groups/:groupId/messages', getGroupMessages);
router.put('/messages/:messageId/read', markMessageAsRead);
router.put('/messages/:messageId', editMessage);
router.delete('/messages/:messageId', deleteMessage);

// Reaction, Pin, Star routes
router.post('/messages/:messageId/reaction', toggleReaction);
router.put('/messages/:messageId/pin', togglePin);
router.put('/messages/:messageId/star', toggleStar);

export default router;
