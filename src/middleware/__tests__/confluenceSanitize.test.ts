/**
 * sanitizeConfluenceHTML — the server-side gate for every Confluence page body.
 * Must keep everything the editor legitimately produces (tables, images from our
 * upload path, code blocks, task lists) and drop anything executable.
 */
import { sanitizeConfluenceHTML, sanitizeHTMLContent } from '../sanitizeHtml';

const PREFIX = '/uploads/confluence-images/';
const clean = (html: string) => sanitizeConfluenceHTML(html, PREFIX);

describe('sanitizeConfluenceHTML — keeps editor output', () => {
  it('keeps headings including h4, lists, code blocks with a language class', () => {
    const html = '<h1>A</h1><h4>B</h4><ul><li><p>x</p></li></ul><pre><code class="language-js">let a = 1;</code></pre>';
    expect(clean(html)).toBe(html);
  });

  it('keeps tables with span attributes and widths', () => {
    const html = '<table style="min-width:75px"><colgroup><col style="min-width:25px" /></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>H</p></th></tr><tr><td colspan="1" rowspan="1"><p>c</p></td></tr></tbody></table>';
    const out = clean(html);
    expect(out).toContain('<table');
    expect(out).toContain('<th colspan="1" rowspan="1">');
    expect(out).toContain('<td colspan="1" rowspan="1">');
  });

  it('keeps images from the module upload path and https', () => {
    expect(clean(`<img src="${PREFIX}abc.webp" alt="x" />`)).toContain(`src="${PREFIX}abc.webp"`);
    expect(clean('<img src="https://example.com/a.png" />')).toContain('src="https://example.com/a.png"');
  });

  it('keeps task lists', () => {
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked /><span></span></label><div><p>Done</p></div></li></ul>';
    const out = clean(html);
    expect(out).toContain('data-type="taskList"');
    expect(out).toContain('data-checked="true"');
  });

  it('keeps @mention spans with the mentioned user id', () => {
    // Exactly what Tiptap's Mention extension emits.
    const html = '<p><span data-type="mention" data-id="aaaaaaaaaaaaaaaaaaaaaaaa" data-label="Priya" data-mention-suggestion-char="@">@Priya</span></p>';
    expect(clean(html)).toBe(html);
  });

  it('still strips event handlers from mention spans', () => {
    const out = clean('<span data-type="mention" data-id="aaaaaaaaaaaaaaaaaaaaaaaa" onmouseover="alert(1)">@P</span>');
    expect(out).not.toContain('onmouseover');
    expect(out).toContain('data-type="mention"');
  });

  it('forces safe link attributes', () => {
    expect(clean('<a href="https://x.com">x</a>')).toBe('<a href="https://x.com" rel="noopener noreferrer" target="_blank">x</a>');
  });
});

describe('sanitizeConfluenceHTML — removes anything executable', () => {
  it('drops script and iframe elements', () => {
    expect(clean('<p>a</p><script>alert(1)</script><iframe src="https://x"></iframe>')).toBe('<p>a</p>');
  });

  it('drops event-handler attributes', () => {
    expect(clean('<p onclick="alert(1)">a</p>')).toBe('<p>a</p>');
    expect(clean(`<img src="${PREFIX}a.webp" onerror="alert(1)" />`)).not.toContain('onerror');
  });

  it('drops javascript: links', () => {
    expect(clean('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('drops images with data:, javascript:, protocol-relative or foreign relative sources', () => {
    expect(clean('<img src="data:image/png;base64,AAAA" />')).toBe('');
    expect(clean('<img src="javascript:alert(1)" />')).toBe('');
    expect(clean('<img src="//evil.com/x.png" />')).toBe('');
    expect(clean('<img src="/uploads/personal-files/secret.pdf" />')).toBe('');
    expect(clean(`<img src="${PREFIX}../personal-files/x" />`)).toBe('');
  });

  it('drops arbitrary classes and dangerous styles', () => {
    const out = clean('<p class="evil" style="position:fixed;color:#ff0000">a</p>');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('position');
  });
});

describe('Notes sanitizer is unchanged', () => {
  it('still strips tables and images from Notes content', () => {
    expect(sanitizeHTMLContent('<table><tbody><tr><td>x</td></tr></tbody></table><img src="https://x/a.png" />')).not.toMatch(/<table|<img/);
  });
});
