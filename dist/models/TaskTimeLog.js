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
exports.TaskTimeLog = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const TaskTimeLogSchema = new mongoose_1.Schema({
    taskId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Task',
        required: true,
        index: true
    },
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
    timeSpent: {
        type: Number,
        required: true,
        min: 0
    },
    description: {
        type: String,
        trim: true,
        maxlength: 500
    },
    loggedAt: {
        type: Date,
        default: Date.now,
        index: true
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
TaskTimeLogSchema.index({ taskId: 1, userId: 1, loggedAt: -1 });
TaskTimeLogSchema.index({ projectId: 1, userId: 1, loggedAt: -1 });
TaskTimeLogSchema.index({ userId: 1, loggedAt: -1 });
TaskTimeLogSchema.statics.findByTask = function (taskId) {
    return this.find({ taskId })
        .populate('userId', 'displayName email photoURL')
        .sort({ loggedAt: -1 });
};
TaskTimeLogSchema.statics.findByUser = function (userId, startDate, endDate) {
    const query = { userId };
    if (startDate || endDate) {
        query.loggedAt = {};
        if (startDate)
            query.loggedAt.$gte = startDate;
        if (endDate)
            query.loggedAt.$lte = endDate;
    }
    return this.find(query)
        .populate('taskId', 'title')
        .populate('projectId', 'name')
        .sort({ loggedAt: -1 });
};
TaskTimeLogSchema.statics.findByProject = function (projectId, startDate, endDate) {
    const query = { projectId };
    if (startDate || endDate) {
        query.loggedAt = {};
        if (startDate)
            query.loggedAt.$gte = startDate;
        if (endDate)
            query.loggedAt.$lte = endDate;
    }
    return this.find(query)
        .populate('userId', 'displayName email')
        .populate('taskId', 'title')
        .sort({ loggedAt: -1 });
};
TaskTimeLogSchema.statics.getTotalTimeByTask = async function (taskId) {
    const result = await this.aggregate([
        { $match: { taskId: new mongoose_1.default.Types.ObjectId(taskId) } },
        { $group: { _id: null, totalTime: { $sum: '$timeSpent' } } }
    ]);
    return result.length > 0 ? result[0].totalTime : 0;
};
TaskTimeLogSchema.statics.getTotalTimeByUser = async function (userId, startDate, endDate) {
    const match = { userId: new mongoose_1.default.Types.ObjectId(userId) };
    if (startDate || endDate) {
        match.loggedAt = {};
        if (startDate)
            match.loggedAt.$gte = startDate;
        if (endDate)
            match.loggedAt.$lte = endDate;
    }
    const result = await this.aggregate([
        { $match: match },
        { $group: { _id: null, totalTime: { $sum: '$timeSpent' } } }
    ]);
    return result.length > 0 ? result[0].totalTime : 0;
};
exports.TaskTimeLog = mongoose_1.default.model('TaskTimeLog', TaskTimeLogSchema);
exports.default = exports.TaskTimeLog;
//# sourceMappingURL=TaskTimeLog.js.map