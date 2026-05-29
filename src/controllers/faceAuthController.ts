import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import { AuthenticatedRequest } from '../middleware/auth';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import AuditLog from '../models/AuditLog';

const FACE_MATCH_THRESHOLD = 0.5; // Euclidean distance — lower = stricter

function euclideanDistance(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0));
}

// ── Register face (requires auth) ─────────────────────────────────────────────

export const registerFace = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { descriptor } = req.body as { descriptor?: number[] };
    if (!descriptor || !Array.isArray(descriptor) || descriptor.length !== 128) {
      return errorResponse(res, 'Invalid face descriptor — expected 128 values', 400);
    }

    await User.findByIdAndUpdate(req.user?._id, { faceDescriptor: descriptor });

    try {
      await AuditLog.logSystemEvent({
        userId: req.user!._id.toString(),
        action: 'biometric_registered',
        metadata: { method: 'face' },
      });
    } catch { /* non-fatal */ }

    return successResponse(res, 'Face registered successfully', { registered: true });
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to register face');
  }
};

// ── Verify face + issue JWT (public — used after password login or face-only login) ──

export const verifyFace = async (req: Request, res: Response) => {
  try {
    const { email, descriptor } = req.body as { email?: string; descriptor?: number[] };

    if (!email || !descriptor || !Array.isArray(descriptor)) {
      return errorResponse(res, 'Email and face descriptor are required', 400);
    }

    const user = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: email.toLowerCase() }],
    }).select('+faceDescriptor');

    if (!user) return errorResponse(res, 'User not found', 404);
    if (!user.isActive) return errorResponse(res, 'Account is deactivated', 403);
    if (!user.faceDescriptor?.length) return errorResponse(res, 'No face registered for this account', 404);

    const distance = euclideanDistance(user.faceDescriptor, descriptor);
    if (distance > FACE_MATCH_THRESHOLD) {
      return errorResponse(res, 'Face not recognized. Please try again.', 401);
    }

    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role },
      jwtSecret,
      { expiresIn: '7d' }
    );

    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_login',
        metadata: { method: 'face' },
      });
    } catch { /* non-fatal */ }

    return successResponse(res, 'Face verified successfully', {
      token,
      user: { id: user._id, email: user.email, displayName: user.displayName, role: user.role },
    });
  } catch (err) {
    return internalServerErrorResponse(res, 'Face verification failed');
  }
};

// ── Face status check (requires auth) ─────────────────────────────────────────

export const getFaceStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findById(req.user?._id);
    if (!user) return errorResponse(res, 'User not found', 404);
    return successResponse(res, 'OK', { hasFace: (user.faceDescriptor?.length ?? 0) > 0 });
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to check face status');
  }
};
