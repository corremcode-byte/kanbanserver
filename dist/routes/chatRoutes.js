"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const chatController_1 = require("../controllers/chatController");
const uploadController_1 = require("../controllers/uploadController");
const auth_1 = require("../middleware/auth");
const upload_1 = __importDefault(require("../middleware/upload"));
const firebase_1 = require("../config/firebase");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/debug/storage', async (_req, res) => {
    try {
        const testFile = firebase_1.bucket.file('test.txt');
        await testFile.save('Hello Firebase!');
        await testFile.makePublic();
        const publicUrl = testFile.publicUrl();
        await testFile.delete();
        res.json({
            success: true,
            bucketConfigured: !!firebase_1.bucket,
            bucketName: firebase_1.bucket?.name || 'Not configured',
            message: 'Firebase Storage is working!',
            testUrl: publicUrl
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            bucketConfigured: !!firebase_1.bucket,
            bucketName: firebase_1.bucket?.name || 'Not configured',
            message: 'Firebase Storage test failed',
            error: error.message
        });
    }
});
router.post('/groups/:groupId/upload-test', upload_1.default.single('file'), (req, res) => {
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
router.post('/groups', chatController_1.createChatGroup);
router.get('/groups', chatController_1.getUserChatGroups);
router.get('/groups/:groupId', chatController_1.getChatGroup);
router.put('/groups/:groupId', chatController_1.updateChatGroup);
router.post('/groups/:groupId/members', chatController_1.addMembersToGroup);
router.delete('/groups/:groupId/members/:userId', chatController_1.removeMemberFromGroup);
router.delete('/groups/:groupId', chatController_1.deleteChatGroup);
router.post('/groups/:groupId/upload', (req, res, next) => {
    const handler = upload_1.default.single('file');
    handler(req, res, (err) => {
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
}, uploadController_1.uploadChatAttachment);
router.post('/messages', chatController_1.sendMessage);
router.get('/groups/:groupId/messages', chatController_1.getGroupMessages);
router.put('/messages/:messageId/read', chatController_1.markMessageAsRead);
exports.default = router;
//# sourceMappingURL=chatRoutes.js.map