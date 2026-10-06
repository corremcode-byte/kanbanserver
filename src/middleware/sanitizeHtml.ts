import sanitizeHtml from 'sanitize-html';
import {
  normalizeWhiteboard,
  whiteboardText,
  WHITEBOARD_MAX_PER_PAGE
} from '../utils/confluenceWhiteboard';
import {
  normalizeStructuredTable,
  structuredTableText,
  TABLE_MAX_PER_PAGE
} from '../utils/confluenceStructuredTable';

/**
 * Sanitizes HTML content to prevent XSS attacks
 * Allows safe tags and attributes for rich text editing
 */
export function sanitizeHTMLContent(html: string): string {
  if (!html) return '';

  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      's',
      'h1',
      'h2',
      'h3',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre',
      'a',
      'span',
      'div',
      'input',
      'label',
      'mark',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      span: ['class', 'style', 'data-color'],
      mark: ['class', 'style', 'data-color'],
      div: ['class', 'style'],
      p: ['class', 'style'],
      strong: ['class', 'style'],
      em: ['class', 'style'],
      u: ['class', 'style'],
      input: ['type', 'checked', 'data-checked', 'data-type'],
      label: ['data-type'],
      '*': ['class'], // Allow class on all tags
    },
    allowedStyles: {
      '*': {
        // Allow hex colors
        color: [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(/, /^rgba\(/, /^hsl\(/, /^hsla\(/],
        'background-color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(/, /^rgba\(/, /^hsl\(/, /^hsla\(/],
        // Allow other text styling
        'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
        'font-weight': [/^\d+$/, /^bold$/, /^normal$/],
        'font-style': [/^italic$/, /^normal$/],
        'text-decoration': [/^underline$/, /^line-through$/, /^none$/],
      },
    },
    // Enforce HTTPS for links
    transformTags: {
      a: (tagName, attribs) => {
        return {
          tagName: 'a',
          attribs: {
            ...attribs,
            rel: 'noopener noreferrer',
            target: attribs.href && !attribs.href.startsWith('#') ? '_blank' : undefined,
          },
        };
      },
    },
  });
}

const CONFLUENCE_COLOR_STYLE = [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\([\d\s.,%]+\)$/, /^hsla?\([\d\s.,%]+\)$/, /^inherit$/];
const CONFLUENCE_LENGTH_STYLE = [/^\d{1,4}(\.\d+)?(px|%|em|rem)$/];

/**
 * Sanitizes a Confluence page body. Separate from sanitizeHTMLContent (Notes) on
 * purpose — Confluence pages additionally carry tables, images, h4 and code-block
 * language classes, and widening the Notes allowlist would change Notes.
 *
 * The allowlist mirrors exactly what the Confluence editor (Tiptap StarterKit +
 * Underline/Link/Highlight/Color/TaskList/Table/Image) can emit. Anything else —
 * scripts, event handlers, iframes, javascript:/data: URLs — is dropped.
 *
 * Images: only http(s) URLs or this module's own relative upload path
 * (`imagePathPrefix`) survive; any other `src` removes the <img> entirely.
 */
export function sanitizeConfluenceHTML(html: string, imagePathPrefix: string): string {
  if (!html) return '';
  let boards = 0;
  let tables = 0;

  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'mark', 'span', 'code',
      'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li', 'blockquote', 'pre',
      'a', 'img',
      'table', 'colgroup', 'col', 'thead', 'tbody', 'tr', 'th', 'td',
      'div', 'label', 'input'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      // data-type/data-id/data-label carry @mentions (the mentioned user's id) —
      // see utils/confluenceMentions.ts. Styling is by attribute, so no class needed.
      span: ['style', 'data-color', 'data-type', 'data-id', 'data-label', 'data-mention-suggestion-char'],
      mark: ['style', 'data-color'],
      code: ['class'],
      pre: ['class'],
      ol: ['start'],
      ul: ['data-type'],
      li: ['data-type', 'data-checked'],
      input: ['type', 'checked'],
      table: ['style'],
      col: ['style', 'span'],
      th: ['colspan', 'rowspan', 'colwidth', 'style'],
      td: ['colspan', 'rowspan', 'colwidth', 'style'],
      // Whiteboard / structured-table blocks only (see the div transform below).
      div: ['data-type', 'data-board', 'data-table'],
      '*': ['class']
    },
    allowedClasses: {
      // Code blocks carry their language as a class; nothing else needs classes.
      code: [/^language-[a-z0-9+#-]+$/i],
      pre: [/^language-[a-z0-9+#-]+$/i],
      '*': []
    },
    allowedStyles: {
      '*': {
        color: CONFLUENCE_COLOR_STYLE,
        'background-color': CONFLUENCE_COLOR_STYLE
      },
      table: { 'min-width': CONFLUENCE_LENGTH_STYLE, width: CONFLUENCE_LENGTH_STYLE },
      col: { 'min-width': CONFLUENCE_LENGTH_STYLE, width: CONFLUENCE_LENGTH_STYLE },
      th: { 'min-width': CONFLUENCE_LENGTH_STYLE, width: CONFLUENCE_LENGTH_STYLE },
      td: { 'min-width': CONFLUENCE_LENGTH_STYLE, width: CONFLUENCE_LENGTH_STYLE }
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer',
          target: attribs.href && !attribs.href.startsWith('#') ? '_blank' : undefined
        }
      }),
      img: (tagName, attribs) => {
        const src = (attribs.src || '').trim();
        const ok = /^https?:\/\//i.test(src) || (src.startsWith(imagePathPrefix) && !src.includes('..'));
        const next = { ...attribs };
        if (!ok) delete next.src;
        return { tagName: 'img', attribs: next };
      },
      // A whiteboard's JSON is rebuilt from a strict schema (utils/confluenceWhiteboard.ts)
      // and its text replaced by its own labels, so neither can carry anything
      // else. Any other div loses the block attributes.
      div: (tagName, attribs) => {
        if (attribs['data-type'] === 'whiteboard' && boards < WHITEBOARD_MAX_PER_PAGE) {
          boards += 1;
          const board = normalizeWhiteboard(attribs['data-board'] || '');
          return {
            tagName: 'div',
            attribs: { 'data-type': 'whiteboard', 'data-board': JSON.stringify(board) },
            text: whiteboardText(board)
          };
        }
        // Structured tables: same treatment — typed JSON rebuilt from a strict
        // schema (utils/confluenceStructuredTable.ts), text derived from it.
        if (attribs['data-type'] === 'structured-table' && tables < TABLE_MAX_PER_PAGE) {
          tables += 1;
          const table = normalizeStructuredTable(attribs['data-table'] || '');
          return {
            tagName: 'div',
            attribs: { 'data-type': 'structured-table', 'data-table': JSON.stringify(table) },
            text: structuredTableText(table)
          };
        }
        return { tagName: 'div', attribs: {} };
      }
    },
    // An <img> whose src was rejected above is dropped rather than left empty.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
  });
}

/**
 * Validates HTML content size
 */
export function validateHtmlSize(html: string, maxLength: number = 50000): boolean {
  if (!html) return true;
  return html.length <= maxLength;
}

/**
 * Strips all HTML tags and returns plain text
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  });
}
