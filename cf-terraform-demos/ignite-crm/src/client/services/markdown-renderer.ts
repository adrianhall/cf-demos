/**
 * @file The Markdown renderer implementation, loaded lazily. Import it **only** through
 *   `./markdown.ts`, which dynamic-imports this module so `marked` and `dompurify` live in their
 *   own chunk and stay out of the initial SPA download (see that file for why). This is where note
 *   Markdown becomes HTML. Notes are user-authored and shared across the whole team, so their text
 *   is untrusted input to every other user's browser. Two independent layers make the output safe
 *   for `v-html`:
 *
 *   1. **The parser never emits active content.** A dedicated `marked` instance renders raw HTML
 *      blocks and inline tags as escaped text (HTML is _disabled_, not stripped, so a note that
 *      mentions `<b>` still shows it), renders images as their alt text (no third-party requests,
 *      no tracking pixels), and renders a link only when its URL is `http:`, `https:`, `mailto:`,
 *      or same-origin relative. Anything else — `javascript:`, `data:`, `file:`, obfuscated
 *      variants — keeps its text but loses the link.
 *   2. **DOMPurify is the final boundary.** It sanitises the parser output against a strict tag and
 *      attribute allowlist and the same URL allowlist, so a parser bug cannot become a script
 *      injection. The supported subset is headings, paragraphs, emphasis, strikethrough, lists,
 *      task lists (read-only checkboxes), block quotes, code, tables, rules, and links.
 */

import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';

/**
 * URL schemes a rendered link may use. Relative URLs (no scheme) are also allowed.
 */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * DOMPurify's URL rule, matching {@link SAFE_PROTOCOLS}: an allowed scheme, or no scheme at all.
 */
const SAFE_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/iu;

/**
 * Escape text for inclusion in HTML.
 *
 * @param text Raw text.
 * @returns HTML-escaped text.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Whether a link target is safe to render as an anchor.
 *
 * The WHATWG URL parser normalises the scheme exactly as a browser would — removing embedded tabs
 * and newlines, lower-casing, and decoding — so `JaVa\tScript:` is recognised for what it is.
 *
 * @param href The link target.
 * @returns `true` for an allowed scheme or a relative URL.
 */
export function isSafeHref(href: string): boolean {
  try {
    // Reject a scheme-like prefix that contains a control character. WHATWG URL parsing strips
    // tabs and newlines; letting that normalisation happen here would turn an obfuscated external
    // URL into a working anchor even though the author did not type a valid scheme.
    // oxlint-disable-next-line eslint/no-control-regex -- Control bytes in a URL are precisely the unsafe input this rule must catch.
    if (/[\u0000-\u001F\u007F]/u.test(href)) {
      return false;
    }
    const base = 'https://relative.invalid/';
    const url = new URL(href, base);
    if (url.origin === new URL(base).origin) {
      return true;
    }
    return SAFE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Whether a link leaves the application.
 *
 * @param href A safe link target.
 * @returns `true` for an absolute `http(s):` or `mailto:` URL.
 */
function isExternal(href: string): boolean {
  // The browser resolves backslashes in network-path references too (`\\\\evil.example`). Use the
  // URL parser rather than a string prefix so those links also get safe `rel` and `target` values.
  const base = 'https://relative.invalid/';
  const url = new URL(href, base);
  return url.protocol === 'mailto:' || url.origin !== new URL(base).origin;
}

/**
 * The note Markdown parser: GFM, line breaks preserved, HTML disabled, images and unsafe links
 * reduced to text, headings shifted below the page's own headings.
 */
const parser = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  // A note is shown under the page's h1 and a section h2, so `# Title` in a note becomes an h3.
  walkTokens: (token) => {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      heading.depth = Math.min(heading.depth + 2, 6);
    }
  },
  renderer: {
    /**
     * Raw HTML (block or inline) is shown as text, never rendered.
     *
     * @param token The HTML token.
     * @returns Escaped text.
     */
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    /**
     * Images become their alt text: no remote fetches from a shared note.
     *
     * @param token The image token.
     * @returns Escaped alt text.
     */
    image(token: Tokens.Image): string {
      return escapeHtml(token.text);
    },
    /**
     * Links render only with a safe target; otherwise just their text.
     *
     * @param token The link token.
     * @returns The anchor, or its text.
     */
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      if (!isSafeHref(token.href)) {
        return text;
      }
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(token.href)}"${title}>${text}</a>`;
    }
  }
});

/**
 * Elements the rendered subset may contain.
 */
const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
];

/**
 * Attributes the rendered subset may carry.
 */
const ALLOWED_ATTR = ['align', 'checked', 'disabled', 'href', 'title', 'type'];

/**
 * The final security boundary: sanitise HTML against the note allowlist, as if the parser had a
 * bug. Exported separately from {@link renderMarkdown} so this second layer is tested on its own
 * with hostile HTML that the parser itself would never emit.
 *
 * @param html HTML from the parser (or, in tests, any untrusted HTML).
 * @returns HTML containing only allowlisted tags and attributes; links with an unsafe target lose
 *   their `href`, external links gain `target="_blank"` and `rel="noopener noreferrer nofollow"`,
 *   non-checkbox inputs are removed, and checkboxes are disabled.
 */
export function sanitizeNoteHtml(html: string): string {
  const purifier = DOMPurify();
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (!isSafeHref(href)) {
        node.removeAttribute('href');
      } else if (isExternal(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    if (node.tagName === 'INPUT') {
      // Only GFM task-list checkboxes survive, and they are display-only.
      if (node.getAttribute('type') !== 'checkbox') {
        node.remove();
        return;
      }
      node.setAttribute('disabled', '');
      // A GFM task box has no <label>; name it by its state so screen readers announce more than
      // “checkbox” (WCAG 1.3.1, 4.1.2). The item's own text follows it in the list item.
      node.setAttribute('aria-label', node.hasAttribute('checked') ? 'Done' : 'Not done');
    }
  });
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    // `aria-label`/`rel`/`target` are added by the hook above after the allowlist has been applied.
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'aria-label', 'rel', 'target'],
    ALLOWED_URI_REGEXP: SAFE_URI
  });
}

/**
 * Render note Markdown as sanitised HTML.
 *
 * @param source Raw Markdown.
 * @returns HTML safe to insert with `v-html`. External links open in a new tab with `rel="noopener
 *   noreferrer nofollow"`; task-list checkboxes are disabled (read-only).
 */
export function renderMarkdown(source: string): string {
  return sanitizeNoteHtml(parser.parse(source) as string);
}
