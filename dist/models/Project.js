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
const ProjectSchema = new mongoose_1.Schema({
    name: {
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
        enum: ['active', 'on-hold', 'completed', 'archived'],
        default: 'active'
    },
    color: {
        type: String,
        default: '#3B82F6'
    },
    ownerId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    owners: [{
            type: mongoose_1.Schema.Types.ObjectId,
            ref: 'User'
        }],
    members: [{
            type: mongoose_1.Schema.Types.ObjectId,
            ref: 'User'
        }],
    managers: [{
            type: mongoose_1.Schema.Types.ObjectId,
            ref: 'User'
        }],
    columns: [{
            id: { type: String, required: true },
            title: { type: String, required: true },
            color: { type: String },
            order: { type: Number, default: 0 }
        }]
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
ProjectSchema.pre('save', function (next) {
    if (this.isNew && (!this.columns || this.columns.length === 0)) {
        this.columns = [
            { id: 'todo', title: 'To Do', color: '#6B7280', order: 0 },
            { id: 'in-progress', title: 'In Progress', color: '#3B82F6', order: 1 },
            { id: 'completed', title: 'Completed', color: '#10B981', order: 2 }
        ];
    }
    next();
});
ProjectSchema.statics.findByUser = function (userId) {
    return this.find({
        $or: [
            { ownerId: userId },
            { members: userId },
            { managers: userId }
        ]
    }).sort({ updatedAt: -1 });
};
const Project = mongoose_1.default.model('Project', ProjectSchema);
exports.default = Project;
//# sourceMappingURL=Project.js.map