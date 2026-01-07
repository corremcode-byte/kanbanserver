"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const path_1 = __importDefault(require("path"));
const database_1 = __importDefault(require("./config/database"));
const routes_1 = __importDefault(require("./routes"));
const errorHandler_1 = require("./middleware/errorHandler");
const app = (0, express_1.default)();
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200);
});
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin)
            return callback(null, true);
        const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
        const localhostPattern = /^https?:\/\/localhost(:\d+)?$/;
        const vercelPattern = /^https:\/\/.*\.vercel\.app$/;
        if (localhostPattern.test(origin) ||
            vercelPattern.test(origin) ||
            allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    preflightContinue: false,
    optionsSuccessStatus: 200
}));
app.use((0, morgan_1.default)('combined'));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
const uploadsPath = path_1.default.join(process.cwd(), 'uploads');
console.log('📁 Serving static files from:', uploadsPath);
app.use('/uploads', (req, res, next) => {
    console.log('🔍 Static file request:', req.method, req.url);
    next();
});
app.use('/uploads', express_1.default.static(uploadsPath, {
    setHeaders: (res, filePath) => {
        console.log('📤 Serving file:', filePath);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));
let dbConnectionPromise = null;
const ensureDBConnection = async () => {
    if (!process.env.MONGODB_URI) {
        console.warn('⚠️  MONGODB_URI not set - skipping MongoDB connection (MySQL migration needed)');
        return;
    }
    if (!dbConnectionPromise) {
        dbConnectionPromise = (0, database_1.default)().catch((error) => {
            console.error('Database connection failed:', error);
            dbConnectionPromise = null;
            throw error;
        });
    }
    return dbConnectionPromise;
};
app.use(async (req, res, next) => {
    try {
        await ensureDBConnection();
    }
    catch (error) {
        console.warn('Database connection warning:', error);
    }
    next();
});
app.get('/', (req, res) => {
    res.json({
        message: 'Kanban API Server',
        status: 'running',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            api: '/api',
            routes: [
                '/api/auth',
                '/api/projects',
                '/api/tasks',
                '/api/users',
                '/api/upload',
                '/api/invitations',
                '/api/permissions',
                '/api/analytics',
                '/api/audit'
            ]
        }
    });
});
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});
app.get('/uploads-test', (req, res) => {
    const fs = require('fs');
    const uploadsPath = path_1.default.join(process.cwd(), 'uploads');
    const exists = fs.existsSync(uploadsPath);
    const files = exists ? fs.readdirSync(uploadsPath) : [];
    res.json({
        uploadsPath,
        exists,
        subdirectories: files
    });
});
app.use('/api', routes_1.default);
app.use(errorHandler_1.notFoundHandler);
app.use(errorHandler_1.globalErrorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map