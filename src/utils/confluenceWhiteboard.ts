/**
 * Confluence whiteboards — structured visual-planning boards embedded in a page.
 *
 * A board is a block inside the page body:
 *   <div data-type="whiteboard" data-board="{json}">labels as plain text</div>
 * so it rides on everything the page body already has: draft/publish, the
 * review lock (423), optimistic concurrency (409), Phase 2 version history and
 * restore, draft visibility, restrictions, encryption at rest and search (the
 * element's text is the board's labels, derived here — never trusted from input).
 *
 * The JSON is never stored as sent: sanitizeConfluenceHTML rebuilds it through
 * normalizeWhiteboard() — known object types only, clamped numbers, capped text,
 * hex colours, connectors only between shapes that exist. Anything unparseable
 * becomes an empty board rather than reaching storage.
 *
 * Format (v1) — kept in sync with the client's whiteboardModel.ts:
 *   { v: 1, h: <canvas height px>, items: Item[] }
 *   Shape     { id, type: rect|rounded|ellipse|diamond|text|note, x, y, w, h, text, fill?, stroke? }
 *   Connector { id, type: arrow|line, from: End, to: End, stroke? }
 *   End       { id: <shape id> } | { x, y }
 */

export const WHITEBOARD_VERSION = 1;
export const WHITEBOARD_MAX_ITEMS = 500;
export const WHITEBOARD_MAX_TEXT = 1000;
export const WHITEBOARD_MAX_PER_PAGE = 20;
export const WHITEBOARD_HEIGHTS = [320, 480, 720] as const;
const DEFAULT_HEIGHT = 480;
const COORD_LIMIT = 20000;
const MIN_SIZE = 10;
const MAX_SIZE = 4000;

export const SHAPE_TYPES = ['rect', 'rounded', 'ellipse', 'diamond', 'text', 'note'] as const;
export const CONNECTOR_TYPES = ['arrow', 'line'] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface WhiteboardShape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill?: string;
  stroke?: string;
}

export type WhiteboardEnd = { id: string } | { x: number; y: number };

export interface WhiteboardConnector {
  id: string;
  type: ConnectorType;
  from: WhiteboardEnd;
  to: WhiteboardEnd;
  stroke?: string;
}

export type WhiteboardItem = WhiteboardShape | WhiteboardConnector;

export interface WhiteboardBoard {
  v: 1;
  h: number;
  items: WhiteboardItem[];
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
}

function color(v: unknown): string | undefined {
  return typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : undefined;
}

function text(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Control characters (except newline/tab) have no place in a label.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, WHITEBOARD_MAX_TEXT);
}

export const emptyWhiteboard = (): WhiteboardBoard => ({ v: 1, h: DEFAULT_HEIGHT, items: [] });

function normalizeShape(raw: Raw, id: string, type: ShapeType): WhiteboardShape | null {
  const x = num(raw.x, -COORD_LIMIT, COORD_LIMIT);
  const y = num(raw.y, -COORD_LIMIT, COORD_LIMIT);
  const w = num(raw.w, MIN_SIZE, MAX_SIZE);
  const h = num(raw.h, MIN_SIZE, MAX_SIZE);
  if (x === null || y === null || w === null || h === null) return null;
  const shape: WhiteboardShape = { id, type, x, y, w, h, text: text(raw.text) };
  const fill = color(raw.fill);
  const stroke = color(raw.stroke);
  if (fill) shape.fill = fill;
  if (stroke) shape.stroke = stroke;
  return shape;
}

function normalizeEnd(raw: unknown, shapeIds: Set<string>): WhiteboardEnd | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id === 'string') return shapeIds.has(raw.id) ? { id: raw.id } : null;
  const x = num(raw.x, -COORD_LIMIT, COORD_LIMIT);
  const y = num(raw.y, -COORD_LIMIT, COORD_LIMIT);
  return x === null || y === null ? null : { x, y };
}

/** Rebuilds a board from untrusted input. Never throws; bad input → empty board. */
export function normalizeWhiteboard(raw: unknown): WhiteboardBoard {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return emptyWhiteboard(); }
  }
  if (!isObject(data) || !Array.isArray(data.items)) return emptyWhiteboard();

  const height = (WHITEBOARD_HEIGHTS as readonly number[]).includes(data.h as number) ? (data.h as number) : DEFAULT_HEIGHT;
  const seen = new Set<string>();
  const shapes: WhiteboardShape[] = [];
  const pendingConnectors: Raw[] = [];

  for (const item of data.items.slice(0, WHITEBOARD_MAX_ITEMS)) {
    if (!isObject(item) || typeof item.id !== 'string' || !ID_RE.test(item.id) || seen.has(item.id)) continue;
    if ((SHAPE_TYPES as readonly string[]).includes(item.type as string)) {
      const shape = normalizeShape(item, item.id, item.type as ShapeType);
      if (shape) { shapes.push(shape); seen.add(item.id); }
    } else if ((CONNECTOR_TYPES as readonly string[]).includes(item.type as string)) {
      pendingConnectors.push(item);
      seen.add(item.id);
    }
  }

  // Connectors are checked after all shapes are known; one pointing at a shape
  // that doesn't exist is dropped.
  const shapeIds = new Set(shapes.map((s) => s.id));
  const connectors: WhiteboardConnector[] = [];
  for (const item of pendingConnectors) {
    const from = normalizeEnd(item.from, shapeIds);
    const to = normalizeEnd(item.to, shapeIds);
    if (!from || !to) continue;
    const connector: WhiteboardConnector = { id: item.id as string, type: item.type as ConnectorType, from, to };
    const stroke = color(item.stroke);
    if (stroke) connector.stroke = stroke;
    connectors.push(connector);
  }

  // Original order matters (z-order); keep it.
  const order = new Map(data.items.map((it, i) => [isObject(it) ? it.id : undefined, i]));
  const items = [...shapes, ...connectors].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { v: 1, h: height, items };
}

const isShape = (item: WhiteboardItem): item is WhiteboardShape => (SHAPE_TYPES as readonly string[]).includes(item.type);

/** The board's labels as plain text — the element's searchable text content. */
export function whiteboardText(board: WhiteboardBoard): string {
  return board.items
    .filter(isShape)
    .map((s) => s.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
}

/* ---------------------------------------------------------------------------
   Reading boards back out of stored (sanitized) HTML — for activity only
   --------------------------------------------------------------------------- */

const BOARD_ATTR_RE = /<div\b[^>]*\bdata-type="whiteboard"[^>]*>/g;
const DATA_BOARD_RE = /\bdata-board="([^"]*)"/;

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Boards in a page body, in document order. */
export function extractWhiteboards(html: string | undefined | null): WhiteboardBoard[] {
  if (!html || !html.includes('data-type="whiteboard"')) return [];
  const boards: WhiteboardBoard[] = [];
  for (const match of html.match(BOARD_ATTR_RE) || []) {
    const attr = DATA_BOARD_RE.exec(match);
    boards.push(normalizeWhiteboard(attr ? decodeEntities(attr[1]) : ''));
  }
  return boards;
}

export type WhiteboardActivityAction =
  | 'confluence_whiteboard_added'
  | 'confluence_whiteboard_removed'
  | 'confluence_whiteboard_cleared'
  | 'confluence_whiteboard_edited';

/**
 * What happened to the page's whiteboards between two bodies — one meaningful
 * entry per save, never per drag. Details are counts only (no labels).
 */
export function whiteboardChange(
  beforeHtml: string | undefined | null,
  afterHtml: string | undefined | null
): { action: WhiteboardActivityAction; details: { boards: number; objects: number } } | null {
  const before = extractWhiteboards(beforeHtml);
  const after = extractWhiteboards(afterHtml);
  const details = { boards: after.length, objects: after.reduce((n, b) => n + b.items.length, 0) };
  if (after.length > before.length) return { action: 'confluence_whiteboard_added', details };
  if (after.length < before.length) return { action: 'confluence_whiteboard_removed', details };
  const sig = (boards: WhiteboardBoard[]) => JSON.stringify(boards);
  if (sig(before) === sig(after)) return null;
  const cleared = after.some((b, i) => b.items.length === 0 && before[i].items.length > 0);
  return { action: cleared ? 'confluence_whiteboard_cleared' : 'confluence_whiteboard_edited', details };
}
