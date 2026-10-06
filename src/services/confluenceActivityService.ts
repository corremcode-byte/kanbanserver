import mongoose from 'mongoose';
import { AuditLog } from '../models';
import type { AuditAction } from '../models/AuditLog';
import { encryptField, decryptField } from '../utils/fieldEncryption';
import { logger } from '../utils/logger';

/**
 * Confluence activity / audit trail — written into the EXISTING AuditLog
 * collection (entityType 'confluence_page', entityId = page id), so it appears in
 * the admin Audit Log alongside everything else and powers the per-page Activity
 * panel. There is no second audit system.
 *
 * Deliberately NOT written through AuditLog.logAction(): that helper broadcasts
 * every entry to EVERY connected socket ('audit:new'), which would push restricted
 * page titles to users who cannot open the page. Entries here are only ever read
 * back through access-checked endpoints (the page Activity panel, after
 * loadVisiblePage) or the admin Audit Log.
 *
 * Entries hold metadata only — never page or comment content. The page title
 * snapshot (useful in the admin log: 'Priya published "CAM Workflow"') is
 * encrypted at rest with the shared field-encryption utility, keyed by the audit
 * entry's own id. Titles are only recorded for events about PUBLISHED content;
 * draft-stage events are flagged `draftOnly` and carry no title, so an unpublished
 * title can never surface to someone who may not see drafts.
 */

export type ConfluenceActivityAction = Extract<AuditAction, `confluence_${string}`>;

export interface ConfluenceActivityInput {
  pageId: string;
  actorId: string;
  action: ConfluenceActivityAction;
  /** Public (published) title at the time. Omit for draft-stage events. */
  pageTitle?: string;
  /** Hidden from readers who cannot see drafts (draft saves, draft creation, ...). */
  draftOnly?: boolean;
  /** Small, non-content details: version numbers, label diffs, comment id, ... */
  details?: Record<string, string | number | boolean | null | string[]>;
}

/** Repeated saves by the same person within this window collapse into one entry. */
export const CONFLUENCE_ACTIVITY_COALESCE_MS = 10 * 60 * 1000;
const COALESCED_ACTIONS = new Set<ConfluenceActivityAction>(['confluence_draft_saved', 'confluence_page_edited', 'confluence_whiteboard_edited', 'confluence_table_edited']);

/**
 * Records one activity entry. Never throws: an audit-write failure must never
 * fail the user's action, so errors are logged and swallowed.
 */
export async function recordConfluenceActivity(input: ConfluenceActivityInput): Promise<void> {
  try {
    if (COALESCED_ACTIONS.has(input.action)) {
      const latest = (await AuditLog.findOne({ entityType: 'confluence_page', entityId: input.pageId })
        .sort({ createdAt: -1 })
        .select('userId action createdAt')
        .lean()) as { userId?: unknown; action?: string; createdAt?: Date } | null;
      if (
        latest &&
        String(latest.userId) === input.actorId &&
        latest.action === input.action &&
        latest.createdAt &&
        Date.now() - new Date(latest.createdAt).getTime() < CONFLUENCE_ACTIVITY_COALESCE_MS
      ) {
        return;
      }
    }

    const _id = new mongoose.Types.ObjectId();
    const metadata: Record<string, unknown> = { module: 'confluence', draftOnly: !!input.draftOnly, ...(input.details || {}) };
    if (input.pageTitle && !input.draftOnly) metadata.pageTitle = encryptField(input.pageTitle, String(_id));

    await new AuditLog({
      _id,
      userId: input.actorId,
      action: input.action,
      entityType: 'confluence_page',
      entityId: input.pageId,
      metadata
    }).save();
  } catch (error) {
    logger.warn(`Failed to record Confluence activity (${input.action}) for page ${input.pageId}:`, error);
  }
}

/** Decrypts the encrypted page-title snapshot of a Confluence audit entry, if any. */
export function decryptConfluenceActivityTitle(log: { _id?: unknown; metadata?: { pageTitle?: unknown } }): string | undefined {
  const raw = log?.metadata?.pageTitle;
  if (typeof raw !== 'string' || !raw) return undefined;
  return decryptField(raw, String(log._id));
}
