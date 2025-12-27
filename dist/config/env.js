"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const result = dotenv_1.default.config({
    path: path_1.default.resolve(process.cwd(), '.env')
});
if (result.error) {
    console.error('Error loading .env file:', result.error);
    console.log('Current working directory:', process.cwd());
    console.log('Looking for .env at:', path_1.default.resolve(process.cwd(), '.env'));
}
console.log('Environment variables loaded:', {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? '✓ Set' : '✗ Missing',
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? '✓ Set' : '✗ Missing',
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? '✓ Set (length: ' + process.env.FIREBASE_PRIVATE_KEY.length + ')' : '✗ Missing',
    MONGODB_URI: process.env.MONGODB_URI ? '✓ Set' : '✗ Missing',
    PORT: process.env.PORT || '4001'
});
exports.default = result;
//# sourceMappingURL=env.js.map