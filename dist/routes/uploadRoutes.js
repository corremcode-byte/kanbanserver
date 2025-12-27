"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const upload_1 = __importDefault(require("../middleware/upload"));
const uploadController_1 = require("../controllers/uploadController");
const multer_1 = require("multer");
const router = express_1.default.Router();
router.use(auth_1.authenticate);
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer_1.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(400).json({
                success: false,
                message: 'File size must be less than 50MB'
            });
            return;
        }
        res.status(400).json({
            success: false,
            message: err.message
        });
        return;
    }
    if (err) {
        res.status(400).json({
            success: false,
            message: err.message || 'File upload failed'
        });
        return;
    }
    next();
};
router.post('/task/:taskId', upload_1.default.single('file'), handleMulterError, uploadController_1.uploadTaskAttachment);
router.get('/task/:taskId/attachments', uploadController_1.getTaskAttachments);
router.delete('/task/:taskId/attachment/:attachmentId', uploadController_1.deleteTaskAttachment);
exports.default = router;
//# sourceMappingURL=uploadRoutes.js.map