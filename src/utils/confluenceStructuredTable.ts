/**
 * Confluence structured tables ("mini databases") — typed rows and columns
 * embedded in a page body, the same way as whiteboards:
 *   <div data-type="structured-table" data-table="{json}">searchable text</div>
 *
 * Being part of the body, a table follows the page through draft/publish, the
 * review lock (423), optimistic concurrency (409), Phase 2 version history and
 * restore, draft visibility, restrictions and encryption at rest. Its text
 * (title, column names, cell values) is derived here and becomes the element's
 * text, so the existing search finds it.
 *
 * The JSON is never stored as sent: sanitizeConfluenceHTML rebuilds it through
 * normalizeStructuredTable(). Ordinary rich-text tables are untouched.
 *
 * Format (v1) — kept in sync with the client's structuredTableModel.ts:
 *   { v: 1, title, columns: Column[], rows: Row[] }
 *   Column { id, name, type: text|number|select|date|checkbox, options?: Option[] }
 *   Option { id, label, color }            (select columns only)
 *   Row    { id, cells: { [columnId]: value } }
 *   value: text → string · number → finite number · select → option id
 *          date → "YYYY-MM-DD" · checkbox → true   (empty cells are omitted)
 */

export const TABLE_MAX_COLUMNS = 30;
export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_OPTIONS = 50;
export const TABLE_MAX_CELL_TEXT = 1000;
export const TABLE_MAX_NAME = 60;
export const TABLE_MAX_TITLE = 120;
export const TABLE_MAX_OPTION_LABEL = 40;
export const TABLE_MAX_PER_PAGE = 20;

export const COLUMN_TYPES = ['text', 'number', 'select', 'date', 'checkbox'] as const;
export const OPTION_COLORS = ['gray', 'blue', 'green', 'yellow', 'red', 'purple'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export type OptionColor = (typeof OPTION_COLORS)[number];

export interface TableOption { id: string; label: string; color: OptionColor }
export interface TableColumn { id: string; name: string; type: ColumnType; options?: TableOption[] }
export type CellValue = string | number | boolean;
export interface TableRow { id: string; cells: Record<string, CellValue> }
export interface StructuredTable { v: 1; title: string; columns: TableColumn[]; rows: TableRow[] }

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER_LIMIT = 1e15;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** Plain one-line-or-multiline text: no control characters, capped. */
function cleanText(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? '' : ' ');
  return stripped.slice(0, max);
}

export function isValidDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export const emptyStructuredTable = (): StructuredTable => ({ v: 1, title: '', columns: [], rows: [] });

function normalizeColumn(raw: Raw): TableColumn | null {
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  if (!(COLUMN_TYPES as readonly string[]).includes(raw.type as string)) return null;
  const column: TableColumn = { id: raw.id, name: cleanText(raw.name, TABLE_MAX_NAME).trim(), type: raw.type as ColumnType };
  if (column.type === 'select') {
    const seen = new Set<string>();
    const options: TableOption[] = [];
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
      if (options.length >= TABLE_MAX_OPTIONS) break;
      if (!isObject(o) || typeof o.id !== 'string' || !ID_RE.test(o.id) || seen.has(o.id)) continue;
      const label = cleanText(o.label, TABLE_MAX_OPTION_LABEL).trim();
      if (!label) continue;
      seen.add(o.id);
      options.push({ id: o.id, label, color: (OPTION_COLORS as readonly string[]).includes(o.color as string) ? (o.color as OptionColor) : 'gray' });
    }
    column.options = options;
  }
  return column;
}

/** A cell value valid for its column, or undefined (= empty / rejected). */
export function normalizeCell(column: TableColumn, value: unknown): CellValue | undefined {
  switch (column.type) {
    case 'text': {
      const text = cleanText(value, TABLE_MAX_CELL_TEXT, true);
      return text.trim() ? text : undefined;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= NUMBER_LIMIT ? value : undefined;
    case 'select':
      return typeof value === 'string' && (column.options || []).some((o) => o.id === value) ? value : undefined;
    case 'date':
      return isValidDate(value) ? value : undefined;
    case 'checkbox':
      return value === true ? true : undefined;
    default:
      return undefined;
  }
}

/** Rebuilds a table from untrusted input. Never throws; bad input → empty table. */
export function normalizeStructuredTable(raw: unknown): StructuredTable {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return emptyStructuredTable(); }
  }
  if (!isObject(data)) return emptyStructuredTable();

  const columns: TableColumn[] = [];
  const columnIds = new Set<string>();
  for (const c of Array.isArray(data.columns) ? data.columns : []) {
    if (columns.length >= TABLE_MAX_COLUMNS) break;
    if (!isObject(c)) continue;
    const column = normalizeColumn(c);
    if (!column || columnIds.has(column.id)) continue;
    columnIds.add(column.id);
    columns.push(column);
  }

  const rows: TableRow[] = [];
  const rowIds = new Set<string>();
  for (const r of Array.isArray(data.rows) ? data.rows : []) {
    if (rows.length >= TABLE_MAX_ROWS) break;
    if (!isObject(r) || typeof r.id !== 'string' || !ID_RE.test(r.id) || rowIds.has(r.id)) continue;
    const rawCells = isObject(r.cells) ? r.cells : {};
    const cells: Record<string, CellValue> = {};
    // Only known columns, in column order; anything else in `cells` is dropped.
    for (const column of columns) {
      if (!Object.prototype.hasOwnProperty.call(rawCells, column.id)) continue;
      const value = normalizeCell(column, rawCells[column.id]);
      if (value !== undefined) cells[column.id] = value;
    }
    rowIds.add(r.id);
    rows.push({ id: r.id, cells });
  }

  return { v: 1, title: cleanText(data.title, TABLE_MAX_TITLE).trim(), columns, rows };
}

/** How a cell reads as text (search; never used for storage). */
export function cellText(column: TableColumn, value: CellValue | undefined): string {
  if (value === undefined) return '';
  switch (column.type) {
    case 'select': return (column.options || []).find((o) => o.id === value)?.label || '';
    case 'checkbox': return value === true ? column.name : '';
    default: return String(value);
  }
}

/** Title, column names and cell values as plain text — the element's searchable text. */
export function structuredTableText(table: StructuredTable): string {
  const parts: string[] = [];
  if (table.title) parts.push(table.title);
  parts.push(...table.columns.map((c) => c.name).filter(Boolean));
  for (const row of table.rows) {
    for (const column of table.columns) {
      const t = cellText(column, row.cells[column.id]).replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(' · ');
}

/* ---------------------------------------------------------------------------
   Reading tables back out of stored (sanitized) HTML — for activity only
   --------------------------------------------------------------------------- */

const TABLE_TAG_RE = /<div\b[^>]*\bdata-type="structured-table"[^>]*>/g;
const DATA_TABLE_RE = /\bdata-table="([^"]*)"/;

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractStructuredTables(html: string | undefined | null): StructuredTable[] {
  if (!html || !html.includes('data-type="structured-table"')) return [];
  return (html.match(TABLE_TAG_RE) || []).map((tag) => {
    const attr = DATA_TABLE_RE.exec(tag);
    return normalizeStructuredTable(attr ? decodeEntities(attr[1]) : '');
  });
}

export type StructuredTableActivityAction =
  | 'confluence_table_added'
  | 'confluence_table_removed'
  | 'confluence_table_cleared'
  | 'confluence_table_columns_changed'
  | 'confluence_table_edited';

/**
 * What a save did to the page's structured tables — one entry per save, counts
 * only (never names or values, which may be confidential).
 */
export function structuredTableChange(
  beforeHtml: string | undefined | null,
  afterHtml: string | undefined | null
): { action: StructuredTableActivityAction; details: Record<string, number> } | null {
  const before = extractStructuredTables(beforeHtml);
  const after = extractStructuredTables(afterHtml);
  const details: Record<string, number> = {
    tables: after.length,
    rows: after.reduce((n, t) => n + t.rows.length, 0),
    columns: after.reduce((n, t) => n + t.columns.length, 0)
  };
  if (after.length > before.length) return { action: 'confluence_table_added', details };
  if (after.length < before.length) return { action: 'confluence_table_removed', details };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;

  let added = 0;
  let removed = 0;
  after.forEach((t, i) => {
    const was = new Set(before[i].columns.map((c) => c.id));
    const now = new Set(t.columns.map((c) => c.id));
    added += [...now].filter((id) => !was.has(id)).length;
    removed += [...was].filter((id) => !now.has(id)).length;
  });
  if (added || removed) return { action: 'confluence_table_columns_changed', details: { ...details, columnsAdded: added, columnsRemoved: removed } };
  const cleared = after.some((t, i) => t.rows.length === 0 && before[i].rows.length > 0);
  return { action: cleared ? 'confluence_table_cleared' : 'confluence_table_edited', details };
}
