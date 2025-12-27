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
exports.ProjectInvitation = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const ProjectInvitationSchema = new mongoose_1.Schema({
    projectId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Project',
        required: true,
        index: true
    },
    invitedEmail: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true
    },
    invitedBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: ['assignee', 'manager'],
        required: true
    },
    permissions: {
        type: {
            canCreateTasks: { type: Boolean, default: false },
            canEditTasks: { type: Boolean, default: false },
            canDeleteTasks: { type: Boolean, default: false },
            canAssignTasks: { type: Boolean, default: false },
            canEditProject: { type: Boolean, default: false },
            canManageMembers: { type: Boolean, default: false },
            canViewAllTasks: { type: Boolean, default: false },
            canManagePermissions: { type: Boolean, default: false }
        },
        required: false
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected', 'expired', 'completed'],
        default: 'pending',
        index: true
    },
    token: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true,
        default: () => {
            const d = new Date();
            d.setDate(d.getDate() + 7);
            return d;
        }
    },
    acceptedAt: Date,
    rejectedAt: Date
}, {
    timestamps: true,
    toJSON: {
        transform: function (doc, ret) {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
            delete ret.token;
            return ret;
        }
    }
});
ProjectInvitationSchema.index({ projectId: 1, invitedEmail: 1, status: 1 });
ProjectInvitationSchema.index({ token: 1, expiresAt: 1 });
ProjectInvitationSchema.statics.findPendingByEmail = function (email) {
    return this.find({
        invitedEmail: email.toLowerCase(),
        status: 'pending',
        expiresAt: { $gt: new Date() }
    })
        .populate('projectId', 'name description color')
        .populate('invitedBy', 'displayName email')
        .sort({ createdAt: -1 });
};
ProjectInvitationSchema.statics.findByToken = function (token) {
    return this.findOne({
        token,
        status: 'pending',
        expiresAt: { $gt: new Date() }
    })
        .populate('projectId', 'name description color')
        .populate('invitedBy', 'displayName email');
};
ProjectInvitationSchema.pre('save', function (next) {
    if (this.isNew && !this.expiresAt) {
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + 7);
        this.expiresAt = expirationDate;
    }
    next();
});
exports.ProjectInvitation = mongoose_1.default.model('ProjectInvitation', ProjectInvitationSchema);
exports.default = exports.ProjectInvitation;
//# sourceMappingURL=ProjectInvitation.js.map