"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bucket = void 0;
require("./env");
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const logger_1 = require("../utils/logger");
if (!process.env.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID is not set in environment variables');
}
if (!process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error('FIREBASE_CLIENT_EMAIL is not set in environment variables');
}
if (!process.env.FIREBASE_PRIVATE_KEY) {
    throw new Error('FIREBASE_PRIVATE_KEY is not set in environment variables');
}
if (!firebase_admin_1.default.apps.length) {
    try {
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        };
        logger_1.logger.info('Initializing Firebase Admin with:', {
            projectId: serviceAccount.projectId,
            clientEmail: serviceAccount.clientEmail,
            privateKeyLength: serviceAccount.privateKey?.length || 0
        });
        firebase_admin_1.default.initializeApp({
            credential: firebase_admin_1.default.credential.cert(serviceAccount),
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
        });
        logger_1.logger.info('Firebase Admin initialized successfully with storage bucket:', process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`);
    }
    catch (error) {
        logger_1.logger.error('Failed to initialize Firebase Admin:', error);
        throw error;
    }
}
exports.bucket = firebase_admin_1.default.storage().bucket();
exports.default = firebase_admin_1.default;
//# sourceMappingURL=firebase.js.map