import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { generateRoute, generatePublicRoute, validateRoute, clearUserRoutes } from '../controllers/dynamicRouteController';

const router = Router();

// Generate a new dynamic route token — user must be authenticated
router.post('/generate', authenticate, generateRoute);

// Generate a token for public pages (login, signup, etc.) — no auth needed
router.post('/generate-public', generatePublicRoute);

// Validate a token — called server-to-server by Next.js middleware (no user auth needed)
router.post('/validate', validateRoute);

// Clear all routes for the current user — called on logout
router.delete('/clear', authenticate, clearUserRoutes);

export default router;
