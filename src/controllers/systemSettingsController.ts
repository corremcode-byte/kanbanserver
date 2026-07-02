import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { SystemSettings } from '../models/SystemSettings';
import { successResponse, errorResponse } from '../utils/responses';

const CODE_PATTERN = /^[A-Za-z0-9]{3,32}$/;

async function getOrCreateSettings() {
  let doc = await SystemSettings.findOne({ singletonKey: 'global' });
  if (!doc) {
    doc = await SystemSettings.create({ singletonKey: 'global' }); // schema default seeds searchAccessCode
  }
  return doc;
}

// GET /api/system-settings/search-access-code — super admin only
export async function getSearchAccessCode(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const settings = await getOrCreateSettings();
    successResponse(res, 'Search access code retrieved', { searchAccessCode: settings.searchAccessCode });
  } catch {
    errorResponse(res, 'Failed to retrieve search access code', 500);
  }
}

// PUT /api/system-settings/search-access-code — super admin only
export async function updateSearchAccessCode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    errorResponse(res, 'Access code must be 3-32 characters, letters and numbers only (no spaces or symbols)', 400);
    return;
  }

  try {
    const settings = await getOrCreateSettings();
    settings.searchAccessCode = code;
    settings.updatedBy = req.user?._id as any;
    await settings.save();
    successResponse(res, 'Search access code updated', { searchAccessCode: settings.searchAccessCode });
  } catch {
    errorResponse(res, 'Failed to update search access code', 500);
  }
}

// POST /api/system-settings/search-access-code/verify — public, no auth.
// Returns only a boolean — the stored code itself is never exposed here.
export async function verifySearchAccessCode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== 'string') {
    res.json({ valid: false });
    return;
  }

  try {
    const settings = await getOrCreateSettings();
    res.json({ valid: settings.searchAccessCode === code });
  } catch {
    res.json({ valid: false });
  }
}
