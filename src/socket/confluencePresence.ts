/**
 * Confluence page presence ("Priya is editing") over the existing Socket.IO server.
 *
 * Scope — deliberately NOT real-time content sync. Simultaneous editing without
 * lost edits needs a CRDT/OT layer (Yjs + y-prosemirror + a sync provider +
 * server-side document persistence), which this app does not have. Draft writes
 * keep going through the REST API with its optimistic-concurrency (409) and
 * review-lock (423) checks; this module only tells people who else is there and,
 * via emitConfluencePageChanged, that the draft moved on — never any content.
 *
 * Security model:
 * - The socket is already JWT-authenticated (socketAuth). On every join AND every
 *   heartbeat the user and page are reloaded and must pass: active user, module
 *   view (or super admin), page + ancestor visibility (restrictions), and draft
 *   visibility. Anyone else gets the same bare `{ ok: false }` whether the page
 *   exists or not, and is removed from the room.
 * - Only users who can edit the page — and only while it is NOT in review —
 *   are listed as editors. Viewers who may see drafts receive the editor list
 *   but never appear in it.
 * - Restriction changes, moves and deletes call revalidateConfluencePresence(),
 *   which re-checks everyone currently present and evicts whoever lost access.
 * - Confluence rooms are not registered in socketHandlers' socketRooms map, so
 *   the global `user:offline` broadcast never reaches them.
 *
 * Cleanup: entries go on leave, on socket disconnect ('disconnecting'), and when
 * no heartbeat arrived within PRESENCE_TTL_MS (tab frozen, network lost). The
 * sweep timer only runs while something is tracked.
 */
import mongoose from 'mongoose';
import type { Server as SocketIOServer } from 'socket.io';
import { getSocketUserId, type AuthenticatedSocket } from './socketAuth';
import {
  normalizeConfluencePerms,
  isVisibleWithAncestors,
  canSeeDrafts,
  canEditPage,
  type ConfluenceAccess,
  type ConfluencePageLike
} from '../utils/confluenceAccess';
import { isDraftLocked } from '../utils/confluenceReview';
import { logger } from '../utils/logger';

/** Clients heartbeat every 20s; three missed beats' worth of slack before removal. */
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 15_000;
/** One socket = one tab; a tab shows one page (plus slack for quick navigation). */
const MAX_PAGES_PER_SOCKET = 5;

export const confluenceRoom = (pageId: string) => `confluence:page:${pageId}`;

export interface PresenceEditor {
  userId: string;
  displayName: string;
}

interface PresenceEntry {
  userId: string;
  displayName: string;
  /** Listed as an editor (has the editor open AND may edit AND not in review). */
  editing: boolean;
  /** Asked to be listed as an editor; re-applied when a review ends. */
  wantsEditing: boolean;
  lastSeen: number;
}

/* ---------------------------------------------------------------------------
   Store — pure, in-memory, one per process
   --------------------------------------------------------------------------- */

export class ConfluencePresenceStore {
  private readonly pages = new Map<string, Map<string, PresenceEntry>>();
  private readonly socketPages = new Map<string, Set<string>>();

  constructor(private readonly ttlMs = PRESENCE_TTL_MS) {}

  get size(): number {
    return this.pages.size;
  }

  has(pageId: string, socketId: string): boolean {
    return !!this.pages.get(pageId)?.has(socketId);
  }

  pageCountFor(socketId: string): number {
    return this.socketPages.get(socketId)?.size || 0;
  }

  pageIds(): string[] {
    return [...this.pages.keys()];
  }

  entries(pageId: string): Array<[string, PresenceEntry]> {
    return [...(this.pages.get(pageId)?.entries() || [])];
  }

  upsert(pageId: string, socketId: string, entry: PresenceEntry): void {
    let page = this.pages.get(pageId);
    if (!page) { page = new Map(); this.pages.set(pageId, page); }
    page.set(socketId, entry);
    let mine = this.socketPages.get(socketId);
    if (!mine) { mine = new Set(); this.socketPages.set(socketId, mine); }
    mine.add(pageId);
  }

  /** True when something was removed. */
  remove(pageId: string, socketId: string): boolean {
    const page = this.pages.get(pageId);
    if (!page || !page.delete(socketId)) return false;
    if (page.size === 0) this.pages.delete(pageId);
    const mine = this.socketPages.get(socketId);
    mine?.delete(pageId);
    if (mine && mine.size === 0) this.socketPages.delete(socketId);
    return true;
  }

  /** Removes every entry of a socket; returns the affected page ids. */
  removeSocket(socketId: string): string[] {
    const pageIds = [...(this.socketPages.get(socketId) || [])];
    pageIds.forEach((pageId) => this.remove(pageId, socketId));
    return pageIds;
  }

  /** Drops entries without a heartbeat within the TTL; returns [pageId, socketId] pairs removed. */
  sweep(now: number): Array<[string, string]> {
    const removed: Array<[string, string]> = [];
    for (const [pageId, page] of this.pages) {
      for (const [socketId, entry] of page) {
        if (now - entry.lastSeen > this.ttlMs) removed.push([pageId, socketId]);
      }
    }
    removed.forEach(([pageId, socketId]) => this.remove(pageId, socketId));
    return removed;
  }

  /** Distinct users currently editing, by name. One user in two tabs counts once. */
  editorsOf(pageId: string): PresenceEditor[] {
    const byUser = new Map<string, PresenceEditor>();
    for (const entry of this.pages.get(pageId)?.values() || []) {
      if (entry.editing && !byUser.has(entry.userId)) {
        byUser.set(entry.userId, { userId: entry.userId, displayName: entry.displayName });
      }
    }
    return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  }
}

/* ---------------------------------------------------------------------------
   Access — reloaded from the database on every join / heartbeat
   --------------------------------------------------------------------------- */

export type PresenceAccess =
  | { ok: false }
  | { ok: true; displayName: string; canEdit: boolean };

const SKELETON_FIELDS = '_id parentId path status createdBy restrictedTo isTemplate isDeleted';

type AnyDoc = Record<string, any>;

/**
 * May `userId` take part in presence on `pageId` right now? Mirrors the REST
 * rules: module view + page/ancestor visibility (restricted → not found) + draft
 * visibility. `canEdit` additionally needs edit rights and no review lock.
 */
export async function checkPresenceAccess(userId: string, pageId: string): Promise<PresenceAccess> {
  if (!mongoose.Types.ObjectId.isValid(pageId) || !mongoose.Types.ObjectId.isValid(userId)) return { ok: false };
  const { User, ConfluencePage } = await import('../models');

  const user = (await User.findById(userId)
    .select('_id displayName role isActive permissions.modules.confluence')
    .lean()) as AnyDoc | null;
  if (!user || !user.isActive) return { ok: false };
  const access: ConfluenceAccess = {
    userId: String(user._id),
    isSuperAdmin: user.role === 'superadmin',
    perms: normalizeConfluencePerms(user.permissions?.modules?.confluence)
  };
  if (!access.isSuperAdmin && !access.perms.view) return { ok: false };

  const page = (await ConfluencePage.findOne({ _id: pageId, isDeleted: false })
    .select(`${SKELETON_FIELDS} reviewState`)
    .lean()) as AnyDoc | null;
  if (!page) return { ok: false };

  const path = Array.isArray(page.path) ? page.path : [];
  const ancestors = page.isTemplate || path.length === 0
    ? []
    : (((await ConfluencePage.find({ _id: { $in: path }, isDeleted: false }).select(SKELETON_FIELDS).lean()) || []) as AnyDoc[]);
  const byId = new Map<string, ConfluencePageLike>(ancestors.map((a) => [String(a._id), a]));

  if (!isVisibleWithAncestors(access, page, byId)) return { ok: false };
  // Presence reveals who is working on the draft: draft-capable users only.
  if (!canSeeDrafts(access, page)) return { ok: false };

  return {
    ok: true,
    displayName: user.displayName || 'Unknown user',
    canEdit: canEditPage(access, page) && !isDraftLocked(page)
  };
}

/* ---------------------------------------------------------------------------
   Socket wiring
   --------------------------------------------------------------------------- */

export interface PresenceDeps {
  checkAccess: (userId: string, pageId: string) => Promise<PresenceAccess>;
  now: () => number;
}

const defaultDeps: PresenceDeps = { checkAccess: checkPresenceAccess, now: () => Date.now() };

let store = new ConfluencePresenceStore();
let ioRef: SocketIOServer | null = null;
let deps: PresenceDeps = defaultDeps;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** socketId:pageId → counter; bumps on every join/leave so a slow access check can't resurrect a left entry. */
const sequence = new Map<string, number>();

type Ack = (response: unknown) => void;

const seqKey = (socketId: string, pageId: string) => `${socketId}:${pageId}`;
const bump = (socketId: string, pageId: string) => {
  const key = seqKey(socketId, pageId);
  const next = (sequence.get(key) || 0) + 1;
  sequence.set(key, next);
  return next;
};

function broadcast(pageId: string): void {
  ioRef?.to(confluenceRoom(pageId)).emit('confluence:presence', { pageId, editors: store.editorsOf(pageId) });
}

function signature(pageId: string): string {
  return store.editorsOf(pageId).map((e) => `${e.userId}:${e.displayName}`).join('|');
}

/** Removes a socket from a page's presence AND its room (so it stops receiving signals). */
function evict(pageId: string, socketId: string): boolean {
  const removed = store.remove(pageId, socketId);
  sequence.delete(seqKey(socketId, pageId));
  try {
    ioRef?.in(socketId).socketsLeave(confluenceRoom(pageId));
  } catch (error) {
    logger.warn('Confluence presence: could not remove socket from room', error);
  }
  return removed;
}

function ensureSweeper(): void {
  if (sweepTimer || store.size === 0) return;
  sweepTimer = setInterval(sweepNow, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function stopSweeperIfIdle(): void {
  if (sweepTimer && store.size === 0) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Removes stale entries now (exported for tests; normally run by the timer). */
export function sweepNow(): void {
  const removed = store.sweep(deps.now());
  const pages = new Set<string>();
  removed.forEach(([pageId, socketId]) => {
    sequence.delete(seqKey(socketId, pageId));
    try {
      ioRef?.in(socketId).socketsLeave(confluenceRoom(pageId));
    } catch { /* socket already gone */ }
    pages.add(pageId);
  });
  pages.forEach(broadcast);
  stopSweeperIfIdle();
}

function parsePayload(raw: unknown): { pageId: string; editing: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { pageId, editing } = raw as Record<string, unknown>;
  if (typeof pageId !== 'string' || !mongoose.Types.ObjectId.isValid(pageId)) return null;
  return { pageId, editing: editing === true };
}

const reply = (ack: unknown, response: unknown) => {
  if (typeof ack === 'function') (ack as Ack)(response);
};

/**
 * Registers the presence events on one connected socket. Called from
 * socketHandlers' connection handler; the io instance is shared by all sockets.
 */
export function registerConfluencePresence(io: SocketIOServer, socket: AuthenticatedSocket): void {
  ioRef = io;
  const userId = getSocketUserId(socket);
  if (!userId) return;

  // join and heartbeat are the same idempotent operation: re-check access, then
  // (re)record presence. Also how a client changes view ↔ edit mode.
  const joinOrBeat = async (raw: unknown, ack: unknown) => {
    try {
      const payload = parsePayload(raw);
      if (!payload) { reply(ack, { ok: false }); return; }
      const { pageId } = payload;

      if (!store.has(pageId, socket.id) && store.pageCountFor(socket.id) >= MAX_PAGES_PER_SOCKET) {
        reply(ack, { ok: false });
        return;
      }

      const mySeq = bump(socket.id, pageId);
      const access = await deps.checkAccess(userId, pageId);
      // A leave (or newer join) arrived while we were checking: it wins.
      if (sequence.get(seqKey(socket.id, pageId)) !== mySeq || socket.disconnected) return;

      if (!access.ok) {
        const before = signature(pageId);
        if (evict(pageId, socket.id) && signature(pageId) !== before) broadcast(pageId);
        reply(ack, { ok: false });
        return;
      }

      const before = signature(pageId);
      socket.join(confluenceRoom(pageId));
      store.upsert(pageId, socket.id, {
        userId,
        displayName: access.displayName,
        wantsEditing: payload.editing,
        editing: payload.editing && access.canEdit,
        lastSeen: deps.now()
      });
      ensureSweeper();
      if (signature(pageId) !== before) broadcast(pageId);
      // `userId` is the caller's own id, so the client can leave itself out of the list.
      reply(ack, { ok: true, userId, canEdit: access.canEdit, editors: store.editorsOf(pageId) });
    } catch (error) {
      logger.error('Confluence presence: join/heartbeat failed', error);
      reply(ack, { ok: false });
    }
  };

  socket.on('confluence:presence:join', joinOrBeat);
  socket.on('confluence:presence:heartbeat', joinOrBeat);

  socket.on('confluence:presence:leave', (raw: unknown, ack: unknown) => {
    const payload = parsePayload(raw);
    if (payload) {
      bump(socket.id, payload.pageId);
      const before = signature(payload.pageId);
      if (evict(payload.pageId, socket.id) && signature(payload.pageId) !== before) broadcast(payload.pageId);
      stopSweeperIfIdle();
    }
    reply(ack, { ok: true });
  });

  // 'disconnecting' (not 'disconnect'): the main handler owns 'disconnect'.
  socket.on('disconnecting', () => {
    const pageIds = store.removeSocket(socket.id);
    pageIds.forEach((pageId) => {
      sequence.delete(seqKey(socket.id, pageId));
      broadcast(pageId);
    });
    // Drop sequence keys of pages whose join never completed, too.
    for (const key of sequence.keys()) if (key.startsWith(`${socket.id}:`)) sequence.delete(key);
    stopSweeperIfIdle();
  });
}

/**
 * Re-checks everyone present (on the given pages, or everywhere) and evicts
 * whoever lost access — after restriction changes, moves (ancestors change) and
 * deletes. Also refreshes editor status when a review starts or ends.
 */
export async function revalidateConfluencePresence(pageIds?: string[]): Promise<void> {
  const targets = (pageIds || store.pageIds()).filter((id) => store.size > 0 && store.entries(id).length > 0);
  for (const pageId of targets) {
    const before = signature(pageId);
    let anyRemoved = false;
    for (const [socketId, entry] of store.entries(pageId)) {
      try {
        const access = await deps.checkAccess(entry.userId, pageId);
        if (!store.has(pageId, socketId)) continue; // left meanwhile
        if (!access.ok) {
          anyRemoved = evict(pageId, socketId) || anyRemoved;
        } else {
          store.upsert(pageId, socketId, { ...entry, editing: entry.wantsEditing && access.canEdit });
        }
      } catch (error) {
        logger.error('Confluence presence: revalidation failed', error);
      }
    }
    if (anyRemoved || signature(pageId) !== before) broadcast(pageId);
  }
  stopSweeperIfIdle();
}

export type ConfluencePageChangeKind =
  | 'draft_saved'
  | 'draft_discarded'
  | 'published'
  | 'version_restored'
  | 'review_submitted'
  | 'review_withdrawn'
  | 'review_approved'
  | 'changes_requested'
  | 'deleted';

/**
 * Tells the people present on a page that it changed. Carries NO content and no
 * title — only who, what kind of change and the new concurrency token — and
 * goes only to the page's room, whose members passed the draft-visibility check
 * (re-verified on every heartbeat). The REST concurrency checks stay the
 * authority: this only warns people before they hit a 409.
 */
export function emitConfluencePageChanged(
  pageId: string,
  change: { kind: ConfluencePageChangeKind; updatedAt?: unknown; byUserId: string; byName?: string }
): void {
  if (!ioRef || store.entries(pageId).length === 0) return;
  const updatedAt = change.updatedAt instanceof Date
    ? change.updatedAt.toISOString()
    : typeof change.updatedAt === 'string' ? change.updatedAt : null;
  ioRef.to(confluenceRoom(pageId)).emit('confluence:page:changed', {
    pageId,
    kind: change.kind,
    updatedAt,
    by: { userId: change.byUserId, displayName: change.byName || 'Someone' }
  });
}

/** Test hooks: fresh state and injectable access/clock. */
export function __resetConfluencePresence(overrides: Partial<PresenceDeps> = {}, io: SocketIOServer | null = null): ConfluencePresenceStore {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  store = new ConfluencePresenceStore();
  sequence.clear();
  deps = { ...defaultDeps, ...overrides };
  ioRef = io;
  return store;
}
