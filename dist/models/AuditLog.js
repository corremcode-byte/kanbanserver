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
exports.AuditLog = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const AuditLogSchema = new mongoose_1.Schema({
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
    action: {
        type: String,
        enum: [
            'task_created',
            'task_updated',
            'task_deleted',
            'task_assigned',
            'task_status_changed',
            'task_completed',
            'member_added',
            'member_removed',
            'permission_changed',
            'project_updated',
            'time_logged',
            'comment_added'
        ],
        required: true,
        index: true
    },
    entityType: {
        type: String,
        enum: ['task', 'project', 'member', 'permission', 'comment', 'time_log'],
        required: true
    },
    entityId: {
        type: mongoose_1.Schema.Types.ObjectId,
        index: true
    },
    metadata: {
        type: mongoose_1.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
        transform: function (doc, ret) {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
            return ret;
        }
    }
});
AuditLogSchema.index({ projectId: 1, createdAt: -1 });
AuditLogSchema.index({ projectId: 1, userId: 1, createdAt: -1 });
AuditLogSchema.index({ projectId: 1, action: 1, createdAt: -1 });
AuditLogSchema.statics.logAction = async function (data) {
    const log = new this({
        projectId: data.projectId,
        userId: data.userId,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        metadata: data.metadata || {}
    });
    const savedLog = await log.save();
    await savedLog.populate('userId', 'displayName email photoURL');
    await savedLog.populate('projectId', 'name');
    try {
        const { getIO } = require('../socket');
        const io = getIO();
        io.emit('audit:new', {
            log: savedLog,
            timestamp: new Date()
        });
    }
    catch (error) {
        console.error('Failed to emit audit log event:', error);
    }
    return savedLog;
};
AuditLogSchema.statics.getProjectActivity = function (projectId, options = {}) {
    const query = { projectId };
    if (options.userId) {
        query.userId = options.userId;
    }
    if (options.action) {
        query.action = options.action;
    }
    if (options.startDate || options.endDate) {
        query.createdAt = {};
        if (options.startDate) {
            query.createdAt.$gte = options.startDate;
        }
        if (options.endDate) {
            query.createdAt.$lte = options.endDate;
        }
    }
    return this.find(query)
        .populate('userId', 'displayName email photoURL')
        .sort({ createdAt: -1 })
        .limit(options.limit || 100);
};
AuditLogSchema.statics.getUserStats = async function (projectId, userId, startDate, endDate) {
    const logs = await this.find({
        projectId,
        userId,
        createdAt: { $gte: startDate, $lte: endDate }
    });
    let tasksCompleted = 0;
    let tasksCreated = 0;
    let tasksUpdated = 0;
    let totalTimeLogged = 0;
    logs.forEach((log) => {
        switch (log.action) {
            case 'task_completed':
                tasksCompleted++;
                break;
            case 'task_created':
                tasksCreated++;
                break;
            case 'task_updated':
                tasksUpdated++;
                break;
            case 'time_logged':
                totalTimeLogged += log.metadata?.duration || 0;
                break;
        }
    });
    return {
        tasksCompleted,
        tasksCreated,
        tasksUpdated,
        totalTimeLogged,
        actionsCount: logs.length
    };
};
exports.AuditLog = mongoose_1.default.model('AuditLog', AuditLogSchema);
exports.default = exports.AuditLog;
//# sourceMappingURL=AuditLog.js.map