/**
 * Whiteboard data — the server's guarantee that only well-formed, structured
 * board data is ever stored, whatever a client sends.
 */
import {
  normalizeWhiteboard,
  whiteboardText,
  extractWhiteboards,
  whiteboardChange,
  emptyWhiteboard,
  WHITEBOARD_MAX_ITEMS,
  WHITEBOARD_MAX_TEXT
} from '../confluenceWhiteboard';
import { sanitizeConfluenceHTML, stripHtml } from '../../middleware/sanitizeHtml';

const PREFIX = '/uploads/confluence-images/';
const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const block = (board: unknown, inner = '') => `<div data-type="whiteboard" data-board="${attr(board)}">${inner}</div>`;

const start = { id: 's1', type: 'rect', x: 10, y: 20, w: 160, h: 80, text: 'Start' };
const decide = { id: 's2', type: 'diamond', x: 300, y: 20, w: 140, h: 110, text: 'Approved?', fill: '#FEF3C7' };
const arrow = { id: 'c1', type: 'arrow', from: { id: 's1' }, to: { id: 's2' } };

describe('normalizeWhiteboard', () => {
  it('keeps a valid board exactly (structured objects, not an image)', () => {
    const board = normalizeWhiteboard({ v: 1, h: 720, items: [start, decide, arrow] });
    expect(board).toEqual({
      v: 1,
      h: 720,
      items: [start, { ...decide, fill: '#fef3c7' }, arrow]
    });
  });

  it('drops unknown types, bad ids, duplicates and connectors to missing shapes', () => {
    const board = normalizeWhiteboard({
      v: 1,
      items: [
        start,
        { ...start }, // duplicate id
        { id: 'x1', type: 'iframe', x: 0, y: 0, w: 10, h: 10 },
        { id: 'bad id!', type: 'rect', x: 0, y: 0, w: 10, h: 10 },
        { id: 'c2', type: 'arrow', from: { id: 's1' }, to: { id: 'ghost' } },
        { id: 'c3', type: 'line', from: { id: 's1' }, to: { x: 5, y: 6 } }
      ]
    });
    expect(board.items.map((i) => i.id)).toEqual(['s1', 'c3']);
    expect(board.h).toBe(480);
  });

  it('strips unknown fields, clamps numbers, caps text and rejects non-hex colours', () => {
    const board = normalizeWhiteboard({
      items: [{ id: 's9', type: 'note', x: 1e9, y: -1e9, w: 0, h: 1e9, text: 'x'.repeat(5000), fill: 'red', stroke: 'url(javascript:1)', onclick: 'alert(1)' }]
    });
    const s = board.items[0] as any;
    expect(s).toEqual({ id: 's9', type: 'note', x: 20000, y: -20000, w: 10, h: 4000, text: 'x'.repeat(WHITEBOARD_MAX_TEXT) });
  });

  it('caps the number of objects and survives garbage', () => {
    const many = Array.from({ length: WHITEBOARD_MAX_ITEMS + 50 }, (_, i) => ({ ...start, id: `s${i}` }));
    expect(normalizeWhiteboard({ items: many }).items).toHaveLength(WHITEBOARD_MAX_ITEMS);
    expect(normalizeWhiteboard('{not json')).toEqual(emptyWhiteboard());
    expect(normalizeWhiteboard(null)).toEqual(emptyWhiteboard());
    expect(normalizeWhiteboard({ items: 'nope' })).toEqual(emptyWhiteboard());
  });

  it('exposes the labels as plain text (what search sees)', () => {
    expect(whiteboardText(normalizeWhiteboard({ items: [start, decide, arrow] }))).toBe('Start · Approved?');
  });
});

describe('sanitizeConfluenceHTML with whiteboards', () => {
  it('rebuilds the board JSON and replaces the block text with the board\'s own labels', () => {
    const html = `<p>Intro</p>${block({ v: 1, items: [start, arrow], evil: '<script>' }, 'stale <b>text</b><img src="x" onerror="1">')}<p>After</p>`;
    const out = sanitizeConfluenceHTML(html, PREFIX);
    const [board] = extractWhiteboards(out);
    expect(board).toEqual({ v: 1, h: 480, items: [start] }); // arrow pointed at a missing shape
    expect(stripHtml(out)).toContain('Start');
    expect(stripHtml(out)).not.toContain('stale');
    expect(out).not.toMatch(/onerror|<script|evil/);
    expect(out.startsWith('<p>Intro</p>')).toBe(true);
    expect(out.endsWith('<p>After</p>')).toBe(true);
  });

  it('keeps labels that look like HTML as inert text', () => {
    const out = sanitizeConfluenceHTML(block({ items: [{ ...start, text: '<img src=x onerror=alert(1)>' }] }), PREFIX);
    expect(out).not.toMatch(/<img/);
    expect((extractWhiteboards(out)[0].items[0] as any).text).toBe('<img src=x onerror=alert(1)>');
  });

  it('other divs cannot smuggle whiteboard attributes', () => {
    const out = sanitizeConfluenceHTML('<div data-type="evil" data-board="{}">x</div>', PREFIX);
    expect(out).toBe('<div>x</div>');
  });

  it('leaves pages without whiteboards byte-for-byte as before', () => {
    const html = '<p>Hello <strong>world</strong></p><table><tbody><tr><td>a</td></tr></tbody></table>';
    expect(sanitizeConfluenceHTML(html, PREFIX)).toBe(html);
  });

  it('is idempotent (a stored board re-saved unchanged stays identical)', () => {
    const once = sanitizeConfluenceHTML(block({ v: 1, items: [start, decide, arrow] }), PREFIX);
    expect(sanitizeConfluenceHTML(once, PREFIX)).toBe(once);
  });
});

describe('whiteboardChange (activity)', () => {
  const html = (...boards: unknown[]) => sanitizeConfluenceHTML(boards.map((b) => block(b)).join(''), PREFIX);

  it.each([
    { action: 'confluence_whiteboard_added', before: '', after: html({ items: [start] }) },
    { action: 'confluence_whiteboard_removed', before: html({ items: [start] }), after: '' },
    { action: 'confluence_whiteboard_cleared', before: html({ items: [start] }), after: html({ items: [] }) },
    { action: 'confluence_whiteboard_edited', before: html({ items: [start] }), after: html({ items: [{ ...start, x: 99 }] }) }
  ])('detects $action', ({ before, after, action }) => {
    expect(whiteboardChange(before, after)?.action).toBe(action);
  });

  it('records nothing when the boards did not change, and only counts', () => {
    const same = html({ items: [start, decide] });
    expect(whiteboardChange(same, same)).toBeNull();
    expect(whiteboardChange('', same)?.details).toEqual({ boards: 1, objects: 2 });
  });
});
