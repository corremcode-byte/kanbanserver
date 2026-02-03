import sanitizeHtml from 'sanitize-html';

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
