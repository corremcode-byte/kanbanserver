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
exports.User = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const userSchema = new mongoose_1.Schema({
    firebaseUid: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },
    displayName: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    photoURL: {
        type: String,
        trim: true
    },
    bio: {
        type: String,
        trim: true,
        maxlength: 500
    },
    role: {
        type: String,
        enum: ['admin', 'manager', 'member'],
        default: 'member'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastLoginAt: {
        type: Date,
        default: Date.now
    },
    settings: {
        appearance: {
            theme: {
                type: String,
                enum: ['light', 'dark', 'system'],
                default: 'system'
            },
            colorScheme: {
                type: String,
                default: 'blue'
            },
            fontSize: {
                type: String,
                enum: ['small', 'medium', 'large'],
                default: 'medium'
            }
        },
        notifications: {
            emailNotifications: {
                type: Boolean,
                default: true
            },
            taskDeadlineReminders: {
                type: Boolean,
                default: true
            },
            dailyDigest: {
                type: Boolean,
                default: false
            }
        },
        boardPreferences: {
            defaultView: {
                type: String,
                enum: ['kanban', 'list'],
                default: 'kanban'
            },
            autoArchiveCompleted: {
                type: Boolean,
                default: false
            },
            taskSorting: {
                type: String,
                enum: ['due_date', 'priority', 'alphabetical', 'created_date'],
                default: 'due_date'
            }
        }
    }
}, {
    timestamps: true
});
userSchema.index({ email: 1, isActive: 1 });
userSchema.index({ firebaseUid: 1, isActive: 1 });
userSchema.index({ displayName: 'text', email: 'text' });
userSchema.methods.toJSON = function () {
    const user = this.toObject();
    delete user.__v;
    return user;
};
userSchema.statics.findByFirebaseUid = function (firebaseUid) {
    return this.findOne({ firebaseUid, isActive: true });
};
userSchema.statics.searchUsers = function (query, limit = 10) {
    return this.find({
        $and: [
            { isActive: true },
            {
                $or: [
                    { displayName: { $regex: query, $options: 'i' } },
                    { email: { $regex: query, $options: 'i' } }
                ]
            }
        ]
    })
        .select('firebaseUid email displayName photoURL role lastLoginAt')
        .limit(limit)
        .exec();
};
userSchema.pre('save', function (next) {
    if (this.isModified('email')) {
        this.email = this.email.toLowerCase();
    }
    if (this.isNew && !this.displayName) {
        this.displayName = this.email.split('@')[0];
    }
    next();
});
userSchema.virtual('isManager').get(function () {
    return ['manager', 'admin'].includes(this.role);
});
userSchema.set('toJSON', {
    virtuals: true,
    transform: function (doc, ret) {
        delete ret.__v;
        return ret;
    }
});
exports.User = mongoose_1.default.model('User', userSchema);
exports.default = exports.User;
//# sourceMappingURL=User.js.map