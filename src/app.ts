import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import connectDB from './config/database';
import routes from './routes';
import { globalErrorHandler, notFoundHandler } from './middleware/errorHandler';

const app = express();

// Middleware
app.use(helmet());

// Handle preflight OPTIONS requests explicitly before CORS
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// CORS configuration - allow Vercel domains and localhost
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Parse allowed origins from environment variable
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
    
    // Always allow localhost for development
    const localhostPattern = /^https?:\/\/localhost(:\d+)?$/;
    
    // Allow Vercel preview deployments
    const vercelPattern = /^https:\/\/.*\.vercel\.app$/;
    
    // Check if origin matches allowed patterns
    if (
      localhostPattern.test(origin) ||
      vercelPattern.test(origin) ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }
    
    // For production, you might want to reject unknown origins
    // For now, allow all origins (you can change this)
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Connect to database (lazy connection for serverless)
// NOTE: Currently configured for MongoDB, but should be migrated to MySQL
// In serverless, mongoose connections are cached and reused
let dbConnectionPromise: Promise<void> | null = null;
const ensureDBConnection = async () => {
  // Skip MongoDB connection if MONGODB_URI is not set (for MySQL migration)
  if (!process.env.MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not set - skipping MongoDB connection (MySQL migration needed)');
    return;
  }
  
  if (!dbConnectionPromise) {
    dbConnectionPromise = connectDB().catch((error) => {
      console.error('Database connection failed:', error);
      dbConnectionPromise = null; // Reset on failure
      throw error;
    });
  }
  return dbConnectionPromise;
};

// Connect to database on first request (for serverless compatibility)
app.use(async (req, res, next) => {
  try {
    await ensureDBConnection();
  } catch (error) {
    // Continue even if DB connection fails (might be a cached connection issue or MySQL migration in progress)
    console.warn('Database connection warning:', error);
  }
  next();
});

// Root endpoint - API information
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API routes
app.use('/api', routes);

// 404 handler for undefined routes
app.use(notFoundHandler);

// Global error handling middleware
app.use(globalErrorHandler);

export default app;