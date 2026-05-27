import { Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import { AuthenticatedRequest } from '../middleware/auth';
import { successResponse, errorResponse, internalServerErrorResponse } from '../utils/responses';
import AuditLog from '../models/AuditLog';

const RP_NAME = 'Nataraja';

function getRpId(req: Request): string {
  return process.env.WEBAUTHN_RP_ID || req.hostname;
}

function getOrigin(req: Request): string {
  if (process.env.WEBAUTHN_ORIGIN) return process.env.WEBAUTHN_ORIGIN;
  const origin = req.headers.origin;
  if (origin) return origin;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// ── Registration (requires auth token) ───────────────────────────────────────

export const getRegisterOptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findById(req.user?._id);
    if (!user) return errorResponse(res, 'User not found', 404);

    const rpID = getRpId(req);

    const existingCredentials = (user.webauthnCredentials || []).map(c => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: user.email,
      userDisplayName: user.displayName,
      attestationType: 'none',
      excludeCredentials: existingCredentials,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
      },
    });

    await User.findByIdAndUpdate(req.user?._id, { currentChallenge: options.challenge });

    return res.json({ success: true, data: options });
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to generate registration options');
  }
};

export const verifyRegistration = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findById(req.user?._id).select('+currentChallenge');
    if (!user || !user.currentChallenge) {
      return errorResponse(res, 'No pending registration challenge', 400);
    }

    const rpID = getRpId(req);
    const origin = getOrigin(req);

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return errorResponse(res, 'Biometric registration failed', 400);
    }

    const { credential } = verification.registrationInfo;

    // Store the new credential
    await User.findByIdAndUpdate(user._id, {
      $push: {
        webauthnCredentials: {
          credentialID:        credential.id,
          credentialPublicKey: Buffer.from(credential.publicKey).toString('base64'),
          counter:             credential.counter,
          transports:          req.body.response?.transports || [],
        },
      },
      $unset: { currentChallenge: 1 },
    });

    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'biometric_registered',
        metadata: { credentialID: credential.id },
      });
    } catch { /* non-fatal */ }

    return successResponse(res, 'Biometric registered successfully', { registered: true });
  } catch (err) {
    return errorResponse(res, (err as Error).message || 'Registration verification failed', 400);
  }
};

// ── Authentication (no auth token needed) ────────────────────────────────────

export const getAuthOptions = async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return errorResponse(res, 'Email is required', 400);

    const user = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username: email.toLowerCase() }] });
    if (!user) return errorResponse(res, 'User not found', 404);

    if (!user.isActive) return errorResponse(res, 'Account is deactivated', 403);

    const rpID = getRpId(req);

    const allowCredentials = (user.webauthnCredentials || []).map(c => ({
      id: c.credentialID,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    }));

    if (allowCredentials.length === 0) {
      return errorResponse(res, 'No biometric credentials registered', 404);
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials,
    });

    await User.findByIdAndUpdate(user._id, { currentChallenge: options.challenge });

    return res.json({ success: true, data: options });
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to generate authentication options');
  }
};

export const verifyAuthentication = async (req: Request, res: Response) => {
  try {
    const { email, response } = req.body as { email?: string; response?: { id?: string } };
    if (!email || !response) return errorResponse(res, 'Email and response are required', 400);

    const user = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: email.toLowerCase() }],
    }).select('+currentChallenge');

    if (!user || !user.currentChallenge) {
      return errorResponse(res, 'No pending authentication challenge', 400);
    }

    if (!user.isActive) return errorResponse(res, 'Account is deactivated', 403);

    // Find the matching credential by ID
    const stored = user.webauthnCredentials?.find(c => c.credentialID === response.id);
    if (!stored) return errorResponse(res, 'Credential not found', 404);

    const rpID = getRpId(req);
    const origin = getOrigin(req);

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: user.currentChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id:        stored.credentialID,
        publicKey: Buffer.from(stored.credentialPublicKey, 'base64'),
        counter:   stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });

    if (!verification.verified) {
      return errorResponse(res, 'Biometric authentication failed', 401);
    }

    // Update counter and clear challenge
    await User.findOneAndUpdate(
      { _id: user._id, 'webauthnCredentials.credentialID': stored.credentialID },
      {
        $set: { 'webauthnCredentials.$.counter': verification.authenticationInfo.newCounter },
        $unset: { currentChallenge: 1 },
        lastLoginAt: new Date(),
      }
    );

    // Issue JWT
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
        metadata: { method: 'biometric' },
      });
    } catch { /* non-fatal */ }

    return successResponse(res, 'Biometric login successful', {
      token,
      user: { id: user._id, email: user.email, displayName: user.displayName, role: user.role },
    });
  } catch (err) {
    return errorResponse(res, (err as Error).message || 'Authentication failed', 400);
  }
};

// ── Status check (requires auth) ─────────────────────────────────────────────

export const getBiometricStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findById(req.user?._id);
    if (!user) return errorResponse(res, 'User not found', 404);

    return successResponse(res, 'OK', {
      hasCredentials: (user.webauthnCredentials?.length ?? 0) > 0,
    });
  } catch (err) {
    return internalServerErrorResponse(res, 'Failed to check biometric status');
  }
};
