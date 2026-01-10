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
exports.ProjectPermission = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const ProjectPermissionSchema = new mongoose_1.Schema({
    projectId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Project',
        required: true,
        index: true
    },
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    role: {
        type: String,
        enum: ['owner', 'manager', 'assignee'],
        required: true
    },
    permissions: {
        canCreateTasks: { type: Boolean, default: false },
        canEditTasks: { type: Boolean, default: false },
        canDeleteTasks: { type: Boolean, default: false },
        canAssignTasks: { type: Boolean, default: false },
        canEditProject: { type: Boolean, default: false },
        canManageMembers: { type: Boolean, default: false },
        canViewAllTasks: { type: Boolean, default: false },
        canManagePermissions: { type: Boolean, default: false },
        canCreateChatGroups: { type: Boolean, default: false },
        canDeleteChatGroups: { type: Boolean, default: false }
    },
    customPermissions: {
        type: Map,
        of: Boolean,
        default: {}
    }
}, {
    timestamps: true,
    toJSON: {
        transform: function (doc, ret) {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
            return ret;
        }
    }
});
ProjectPermissionSchema.index({ projectId: 1, userId: 1 }, { unique: true });
ProjectPermissionSchema.statics.getPermissions = function (projectId, userId) {
    return this.findOne({ projectId, userId });
};
ProjectPermissionSchema.statics.getDefaultPermissions = function (role) {
    const defaults = {
        owner: {
            canCreateTasks: true,
            canEditTasks: true,
            canDeleteTasks: true,
            canAssignTasks: true,
            canEditProject: true,
            canManageMembers: true,
            canViewAllTasks: true,
            canManagePermissions: true,
            canCreateChatGroups: true,
            canDeleteChatGroups: true
        },
        manager: {
            canCreateTasks: true,
            canEditTasks: true,
            canDeleteTasks: true,
            canAssignTasks: true,
            canEditProject: false,
            canManageMembers: false,
            canViewAllTasks: true,
            canManagePermissions: false,
            canCreateChatGroups: false,
            canDeleteChatGroups: false
        },
        assignee: {
            canCreateTasks: false,
            canEditTasks: true,
            canDeleteTasks: false,
            canAssignTasks: false,
            canEditProject: false,
            canManageMembers: false,
            canViewAllTasks: false,
            canManagePermissions: false,
            canCreateChatGroups: false,
            canDeleteChatGroups: false
        }
    };
    return defaults[role];
};
ProjectPermissionSchema.pre('save', function (next) {
    if (this.isNew) {
        const defaultPerms = this.constructor.getDefaultPermissions(this.role);
        this.permissions = { ...defaultPerms, ...this.permissions };
    }
    next();
});
exports.ProjectPermission = mongoose_1.default.model('ProjectPermission', ProjectPermissionSchema);
exports.default = exports.ProjectPermission;
//# sourceMappingURL=ProjectPermission.js.map