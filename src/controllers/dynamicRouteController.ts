import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { dynamicRouteStore } from '../lib/dynamicRouteStore';
import { successResponse, errorResponse } from '../utils/responses';

const ALLOWED_DESTINATIONS = /^\/[a-zA-Z0-9/_-]+$/;

// POST /api/routes/generate  — requires auth
export async function generateRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?._id?.toString();
  if (!userId) { errorResponse(res, 'Unauthorized', 401); return; }

  const { destination } = req.body as { destination?: string };
  if (!destination || typeof destination !== 'string') {
    errorResponse(res, 'destination is required', 400); return;
  }
  if (!ALLOWED_DESTINATIONS.test(destination)) {
    errorResponse(res, 'Invalid destination', 400); return;
  }

  try {
    const token = await dynamicRouteStore.generateRoute(userId, destination);
    successResponse(res, 'Route generated', { token, url: `/r/${token}` });
  } catch (err) {
    errorResponse(res, 'Failed to generate route', 500);
  }
}

// POST /api/routes/validate  — no auth (called by Next.js middleware server-to-server)
export async function validateRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
    res.json({ valid: false }); return;
  }

  try {
    const entry = await dynamicRouteStore.validateRoute(token);
    if (!entry) { res.json({ valid: false }); return; }
    res.json({ valid: true, destination: entry.destination, userId: entry.userId });
  } catch {
    res.json({ valid: false });
  }
}

// POST /api/routes/generate-public  — no auth (for login/signup/forgot-password pages)
export async function generatePublicRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { destination } = req.body as { destination?: string };
  if (!destination || typeof destination !== 'string') {
    errorResponse(res, 'destination is required', 400); return;
  }

  try {
    const token = await dynamicRouteStore.generatePublicRoute(destination);
    successResponse(res, 'Public route generated', { token, url: `/r/${token}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to generate route';
    errorResponse(res, msg, 400);
  }
}

// DELETE /api/routes/clear  — requires auth (called on logout)
export async function clearUserRoutes(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?._id?.toString();
  if (!userId) { errorResponse(res, 'Unauthorized', 401); return; }

  try {
    await dynamicRouteStore.clearUserRoutes(userId);
    successResponse(res, 'Routes cleared');
  } catch {
    errorResponse(res, 'Failed to clear routes', 500);
  }
}
