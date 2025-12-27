"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const projectsController = __importStar(require("../controllers/projectsController"));
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/', projectsController.getProjects);
router.post('/', projectsController.createProject);
router.get('/:id', projectsController.getProject);
router.put('/:id', projectsController.updateProject);
router.delete('/:id', projectsController.deleteProject);
router.post('/:id/members', projectsController.addMember);
router.delete('/:id/members/:userId', projectsController.removeMember);
router.put('/:id/members/:userId/role', projectsController.updateMemberRole);
router.put('/:id/owners/:userId', projectsController.addOwner);
router.delete('/:id/owners/:userId', projectsController.removeOwner);
router.post('/:id/transfer-ownership', projectsController.transferOwnership);
router.delete('/:id/leave', projectsController.leaveProject);
router.post('/:id/lists', projectsController.addList);
router.put('/:id/lists/:listId', projectsController.updateList);
router.delete('/:id/lists/:listId', projectsController.deleteList);
router.put('/:id/lists/reorder', projectsController.reorderLists);
exports.default = router;
//# sourceMappingURL=projects.js.map