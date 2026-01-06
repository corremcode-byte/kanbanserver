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
const mongoose_1 = __importStar(require("mongoose"));
const TaskSchema = new mongoose_1.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        default: 'todo'
    },
    listId: {
        type: String,
        default: 'todo'
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium'
    },
    projectId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Project',
        required: true
    },
    assigneeId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User'
    },
    assignedTo: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    assignees: [{
            type: mongoose_1.Schema.Types.ObjectId,
            ref: 'User'
        }],
    assignedBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    assignedAt: {
        type: Date,
        index: true
    },
    createdBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    dueDate: { type: Date },
    completedAt: {
        type: Date,
        index: true
    },
    reminderFrequency: {
        type: String,
        enum: ['none', '1hour', '3hours', '12hours', '24hours', '48hours'],
        default: '24hours'
    },
    lastReminderSent: { type: Date },
    attachments: [{
            id: { type: String, required: true },
            name: { type: String, required: true },
            url: { type: String, required: true },
            type: { type: String, required: true },
            size: { type: Number, required: true },
            uploadedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
            uploadedAt: { type: Date, default: Date.now }
        }],
    comments: [{
            id: { type: String, required: true },
            text: { type: String, required: true, trim: true },
            createdBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
            createdAt: { type: Date, default: Date.now },
            updatedAt: { type: Date }
        }],
    order: { type: Number, default: 0 }
}, {
    timestamps: true,
    toJSON: {
        transform: function (doc, ret) {
            ret.id = ret._id;
            delete ret.__v;
            return ret;
        }
    }
});
TaskSchema.index({ projectId: 1, status: 1, order: 1 });
TaskSchema.index({ projectId: 1, listId: 1, order: 1 });
TaskSchema.index({ assigneeId: 1 });
TaskSchema.pre('save', function (next) {
    if (this.isModified('listId') && !this.isModified('status')) {
        if (this.listId === 'todo')
            this.status = 'todo';
        else if (this.listId === 'in-progress')
            this.status = 'in-progress';
        else if (this.listId === 'completed')
            this.status = 'completed';
        else
            this.status = 'todo';
    }
    if (this.isModified('status') && !this.isModified('listId')) {
        this.listId = this.status;
    }
    next();
});
TaskSchema.statics.findByProject = function (projectId) {
    return this.find({ projectId })
        .sort({ status: 1, order: 1 })
        .populate('assigneeId', 'name email avatar');
};
TaskSchema.statics.findByAssignee = function (userId) {
    return this.find({
        $or: [
            { assigneeId: userId },
            { assignedTo: userId },
            { assignees: userId }
        ]
    })
        .sort({ dueDate: 1, priority: -1 })
        .populate('projectId', 'name color');
};
TaskSchema.statics.reorderTasks = async function (projectId, tasks) {
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        for (const task of tasks) {
            const updateData = {
                status: task.status,
                order: task.order
            };
            if (task.listId) {
                updateData.listId = task.listId;
            }
            else {
                updateData.listId = task.status;
            }
            await this.findByIdAndUpdate(task._id, updateData, { session });
        }
        await session.commitTransaction();
    }
    catch (error) {
        await session.abortTransaction();
        throw error;
    }
    finally {
        session.endSession();
    }
};
const Task = mongoose_1.default.model('Task', TaskSchema);
exports.default = Task;
//# sourceMappingURL=Task.js.map