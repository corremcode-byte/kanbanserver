/**
 * Structured tables — the server's guarantee that only well-formed, typed table
 * data is ever stored, whatever a client sends.
 */
import {
  normalizeStructuredTable,
  structuredTableText,
  extractStructuredTables,
  structuredTableChange,
  emptyStructuredTable,
  isValidDate,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  TABLE_MAX_CELL_TEXT,
  TABLE_MAX_OPTIONS,
  TABLE_MAX_PER_PAGE
} from '../confluenceStructuredTable';
import { sanitizeConfluenceHTML, stripHtml } from '../../middleware/sanitizeHtml';

const PREFIX = '/uploads/confluence-images/';
const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const block = (table: unknown, inner = '') => `<div data-type="structured-table" data-table="${attr(table)}">${inner}</div>`;

const columns = [
  { id: 'project', name: 'Project', type: 'text' },
  { id: 'owner', name: 'Owner', type: 'text' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'active', label: 'Active', color: 'blue' }, { id: 'testing', label: 'Testing', color: 'yellow' }] },
  { id: 'deadline', name: 'Deadline', type: 'date' },
  { id: 'priority', name: 'Priority', type: 'number' },
  { id: 'done', name: 'Done', type: 'checkbox' }
];
const tracker = {
  v: 1,
  title: 'Project Tracker',
  columns,
  rows: [
    { id: 'r1', cells: { project: 'LOS', owner: 'Vicky', status: 'active', deadline: '2026-10-10', priority: 1, done: true } },
    { id: 'r2', cells: { project: 'CAM', owner: 'Priya', status: 'testing', deadline: '2026-10-15', priority: 2 } }
  ]
};

describe('normalizeStructuredTable', () => {
  it('keeps a valid table exactly (ids, types, options, typed values)', () => {
    expect(normalizeStructuredTable(tracker)).toEqual(tracker);
    expect(normalizeStructuredTable(JSON.stringify(tracker))).toEqual(tracker);
  });

  it('drops unknown column types, invalid / duplicate ids and malformed rows', () => {
    const t = normalizeStructuredTable({
      columns: [
        columns[0],
        { id: 'project', name: 'Dup', type: 'text' },
        { id: 'f', name: 'Formula', type: 'formula' },
        { id: 'bad id', name: 'Bad', type: 'text' },
        'not a column'
      ],
      rows: [
        { id: 'r1', cells: { project: 'LOS', ghost: 'x', __proto__: 'y' } },
        { id: 'r1', cells: { project: 'dup row' } },
        { id: '<script>', cells: {} },
        { cells: { project: 'no id' } },
        null
      ]
    });
    expect(t.columns.map((c) => c.id)).toEqual(['project']);
    expect(t.rows).toEqual([{ id: 'r1', cells: { project: 'LOS' } }]);
  });

  it('rejects values of the wrong type — including select values that are not options', () => {
    const t = normalizeStructuredTable({
      columns,
      rows: [{ id: 'r1', cells: { project: 42, owner: '  ', status: 'shipped', deadline: '2026-02-30', priority: 'high', done: 'true' } }]
    });
    expect(t.rows[0].cells).toEqual({});
    const ok = normalizeStructuredTable({ columns, rows: [{ id: 'r1', cells: { status: 'testing', priority: -3.5, deadline: '2024-02-29' } }] });
    expect(ok.rows[0].cells).toEqual({ status: 'testing', priority: -3.5, deadline: '2024-02-29' });
    expect(normalizeStructuredTable({ columns, rows: [{ id: 'r', cells: { priority: Infinity } }] }).rows[0].cells).toEqual({});
  });

  it('validates select options (ids, labels, colours) and their limit', () => {
    const many = Array.from({ length: TABLE_MAX_OPTIONS + 5 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}`, color: 'green' }));
    const t = normalizeStructuredTable({
      columns: [
        { id: 's', name: 'S', type: 'select', options: [{ id: 'a', label: 'A', color: 'url(x)' }, { id: 'a', label: 'dup' }, { id: 'b', label: '   ' }, { id: 'bad id', label: 'x' }] },
        { id: 'm', name: 'M', type: 'select', options: many },
        { id: 't', name: 'T', type: 'text', options: [{ id: 'z', label: 'should not be kept' }] }
      ]
    });
    expect(t.columns[0].options).toEqual([{ id: 'a', label: 'A', color: 'gray' }]);
    expect(t.columns[1].options).toHaveLength(TABLE_MAX_OPTIONS);
    expect(t.columns[2]).not.toHaveProperty('options');
  });

  it('enforces size limits', () => {
    const cols = Array.from({ length: TABLE_MAX_COLUMNS + 10 }, (_, i) => ({ id: `c${i}`, name: 'x'.repeat(500), type: 'text' }));
    const rows = Array.from({ length: TABLE_MAX_ROWS + 10 }, (_, i) => ({ id: `r${i}`, cells: { c0: 'y'.repeat(5000) } }));
    const t = normalizeStructuredTable({ title: 't'.repeat(1000), columns: cols, rows });
    expect(t.columns).toHaveLength(TABLE_MAX_COLUMNS);
    expect(t.rows).toHaveLength(TABLE_MAX_ROWS);
    expect((t.rows[0].cells.c0 as string).length).toBe(TABLE_MAX_CELL_TEXT);
    expect(t.columns[0].name.length).toBe(60);
    expect(t.title.length).toBe(120);
  });

  it('survives garbage', () => {
    expect(normalizeStructuredTable('{nope')).toEqual(emptyStructuredTable());
    expect(normalizeStructuredTable(null)).toEqual(emptyStructuredTable());
    expect(normalizeStructuredTable({ columns: 'x', rows: 5 })).toEqual(emptyStructuredTable());
  });

  it('validates real calendar dates', () => {
    expect(isValidDate('2026-10-10')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('10/10/2026')).toBe(false);
  });

  it('derives searchable text: title, column names and display values', () => {
    expect(structuredTableText(normalizeStructuredTable(tracker))).toBe(
      'Project Tracker · Project · Owner · Status · Deadline · Priority · Done · LOS · Vicky · Active · 2026-10-10 · 1 · Done · CAM · Priya · Testing · 2026-10-15 · 2'
    );
  });
});

describe('sanitizeConfluenceHTML with structured tables', () => {
  it('rebuilds the JSON and replaces the block text with the table\'s own text', () => {
    const out = sanitizeConfluenceHTML(`<p>Intro</p>${block(tracker, 'stale <b>x</b><img src=x onerror=1>')}<p>After</p>`, PREFIX);
    expect(extractStructuredTables(out)).toEqual([tracker]);
    expect(stripHtml(out)).toContain('LOS · Vicky · Active');
    expect(out).not.toMatch(/onerror|stale/);
    expect(out.startsWith('<p>Intro</p>') && out.endsWith('<p>After</p>')).toBe(true);
  });

  it('cell text that looks like HTML stays inert text', () => {
    const t = { columns: [columns[0]], rows: [{ id: 'r', cells: { project: '<script>alert(1)</script>' } }] };
    const out = sanitizeConfluenceHTML(block(t), PREFIX);
    expect(out).not.toMatch(/<script/);
    expect(extractStructuredTables(out)[0].rows[0].cells.project).toBe('<script>alert(1)</script>');
  });

  it('leaves ordinary rich-text tables and whiteboards alone', () => {
    const rich = '<table><tbody><tr><td>a</td></tr></tbody></table>';
    expect(sanitizeConfluenceHTML(rich, PREFIX)).toBe(rich);
    const wb = sanitizeConfluenceHTML('<div data-type="whiteboard" data-board="{&quot;items&quot;:[]}"></div>', PREFIX);
    expect(wb).toContain('data-type="whiteboard"');
    expect(wb).not.toContain('data-table');
  });

  it('caps tables per page and is idempotent', () => {
    const html = Array.from({ length: TABLE_MAX_PER_PAGE + 2 }, () => block(tracker)).join('');
    expect(extractStructuredTables(sanitizeConfluenceHTML(html, PREFIX))).toHaveLength(TABLE_MAX_PER_PAGE);
    const once = sanitizeConfluenceHTML(block(tracker), PREFIX);
    expect(sanitizeConfluenceHTML(once, PREFIX)).toBe(once);
  });
});

describe('structuredTableChange (activity)', () => {
  const html = (...tables: unknown[]) => sanitizeConfluenceHTML(tables.map((t) => block(t)).join(''), PREFIX);
  const withRows = (rows: unknown[]) => ({ ...tracker, rows });

  it.each([
    { action: 'confluence_table_added', before: '', after: html(tracker) },
    { action: 'confluence_table_removed', before: html(tracker), after: '' },
    { action: 'confluence_table_cleared', before: html(tracker), after: html(withRows([])) },
    { action: 'confluence_table_edited', before: html(tracker), after: html(withRows([tracker.rows[0]])) },
    { action: 'confluence_table_columns_changed', before: html(tracker), after: html({ ...tracker, columns: columns.slice(0, 5) }) }
  ])('detects $action', ({ before, after, action }) => {
    expect(structuredTableChange(before, after)?.action).toBe(action);
  });

  it('counts only — never names or values', () => {
    const change = structuredTableChange(html(tracker), html({ ...tracker, columns: [...columns.slice(1), { id: 'new', name: 'Secret', type: 'text' }] }))!;
    expect(change.details).toEqual({ tables: 1, rows: 2, columns: 6, columnsAdded: 1, columnsRemoved: 1 });
    expect(structuredTableChange(html(tracker), html(tracker))).toBeNull();
  });
});
