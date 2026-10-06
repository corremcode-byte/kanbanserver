/**
 * Pure helpers for Confluence @mentions. No I/O.
 *
 * - Page content: the editor (Tiptap Mention extension) stores a mention as
 *   <span data-type="mention" data-id="<userId>" data-label="Name">@Name</span>,
 *   so the mentioned user's ID lives in the content itself.
 * - Comments are plain text ("@Priya please review"); the client sends the
 *   picked user IDs alongside, and the server keeps only those whose "@Name"
 *   still appears in the text (see mentionsPresentInText).
 *
 * Notifications are only ever sent for NEWLY added mentions (newlyMentioned), so
 * re-publishing a page or editing a comment never re-notifies the same person.
 */

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** Hard cap on how many people one page publish / comment can notify. */
export const MAX_MENTIONS_PER_ITEM = 50;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
}

/** User IDs mentioned in (sanitised) page HTML, de-duplicated, in order of appearance. */
export function extractMentionIdsFromHtml(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<span\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    if (attr(tag, 'data-type') !== 'mention') continue;
    const id = attr(tag, 'data-id');
    if (!id || !OBJECT_ID_RE.test(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    ids.push(id);
    if (ids.length >= MAX_MENTIONS_PER_ITEM) break;
  }
  return ids;
}

/** Parses the `mentions` field a client sends with a comment: [{ userId }] or [id]. */
export function parseMentionInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { userId?: unknown }).userId : null;
    if (typeof id !== 'string' || !OBJECT_ID_RE.test(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    ids.push(id);
    if (ids.length >= MAX_MENTIONS_PER_ITEM) break;
  }
  return ids;
}

/**
 * Keeps only the mentioned users whose "@DisplayName" is actually present in the
 * comment text — so deleting the "@Priya" text also drops the mention, and a
 * client cannot attach an invisible mention to notify someone silently.
 */
export function mentionsPresentInText(
  text: string,
  candidates: { _id?: unknown; displayName?: string | null }[]
): string[] {
  const lower = (text || '').toLowerCase();
  return candidates
    .filter((u) => !!u.displayName && lower.includes(`@${String(u.displayName).toLowerCase()}`))
    .map((u) => String(u._id));
}

/** IDs in `next` that were not in `previous` (case-insensitive), excluding `exclude` (the actor). */
export function newlyMentioned(previous: string[], next: string[], exclude?: string): string[] {
  const before = new Set(previous.map((id) => id.toLowerCase()));
  const skip = exclude ? exclude.toLowerCase() : null;
  return next.filter((id) => !before.has(id.toLowerCase()) && id.toLowerCase() !== skip);
}
