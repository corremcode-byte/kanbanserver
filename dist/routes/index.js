"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = __importDefault(require("./auth"));
const projects_1 = __importDefault(require("./projects"));
const tasks_1 = __importDefault(require("./tasks"));
const user_1 = __importDefault(require("./user"));
const uploadRoutes_1 = __importDefault(require("./uploadRoutes"));
const invitations_1 = __importDefault(require("./invitations"));
const permissions_1 = __importDefault(require("./permissions"));
const analytics_1 = __importDefault(require("./analytics"));
const audit_1 = __importDefault(require("./audit"));
const pushNotifications_1 = __importDefault(require("./pushNotifications"));
const comments_1 = __importDefault(require("./comments"));
const search_1 = __importDefault(require("./search"));
const dev_1 = __importDefault(require("./dev"));
const chatRoutes_1 = __importDefault(require("./chatRoutes"));
const router = (0, express_1.Router)();
router.use('/auth', auth_1.default);
router.use('/projects', projects_1.default);
router.use('/tasks', tasks_1.default);
router.use('/users', user_1.default);
router.use('/upload', uploadRoutes_1.default);
router.use('/invitations', invitations_1.default);
router.use('/permissions', permissions_1.default);
router.use('/analytics', analytics_1.default);
router.use('/audit', audit_1.default);
router.use('/push-notifications', pushNotifications_1.default);
router.use('/comments', comments_1.default);
router.use('/search', search_1.default);
router.use('/chat', chatRoutes_1.default);
if (process.env.NODE_ENV !== 'production') {
    router.use('/dev', dev_1.default);
}
exports.default = router;
//# sourceMappingURL=index.js.map