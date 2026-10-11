/**
 * @file The Markdown rendering boundary: the supported subset renders, while raw HTML, unsafe URL
 *   protocols, and dangerous attributes never reach the DOM. Every assertion goes through the
 *   public, lazily loading `renderMarkdown` in `services/markdown.ts`, so the safety rules are
 *   proven against the code path the SPA actually uses after the bundle split.
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/client/services/markdown.ts';

/**
 * Render into a detached element for DOM assertions.
 *
 * @param source Markdown.
 * @returns Once rendered, the container.
 */
async function render(source: string): Promise<HTMLElement> {
  const element = document.createElement('div');
  element.innerHTML = await renderMarkdown(source);
  return element;
}

describe('renderMarkdown', () => {
  it('renders headings, emphasis, lists, task lists, code, and safe links', async () => {
    const element = await render(
      [
        '# Agenda',
        '',
        'Some **bold**, *italic*, and `code`.',
        '',
        '- one',
        '- [x] done item',
        '- [ ] open item',
        '',
        '1. first',
        '',
        '```',
        'const x = 1;',
        '```',
        '',
        '[docs](https://example.com/docs) and [mail](mailto:a@example.com) and [rel](/deals) and [cdn](//cdn.example.com)'
      ].join('\n')
    );
    // Headings shift down two levels so a note never adds a rival page heading.
    expect(element.querySelector('h3')?.textContent).toBe('Agenda');
    expect(element.querySelector('h1')).toBeNull();
    expect(element.querySelector('strong')?.textContent).toBe('bold');
    expect(element.querySelector('em')?.textContent).toBe('italic');
    expect(element.querySelector('pre code')?.textContent).toContain('const x = 1;');
    const boxes = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true]
    ]);
    const anchors = [...element.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      'mailto:a@example.com',
      '/deals',
      '//cdn.example.com'
    ]);
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchors[3]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchors[0]?.getAttribute('target')).toBe('_blank');
    expect(anchors[2]?.hasAttribute('target')).toBe(false);
  });

  it('shows raw HTML as text instead of rendering it', async () => {
    const element = await render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\nok <b>b</b>'
    );
    expect(element.querySelector('script, img, b')).toBeNull();
    expect(element.textContent).toContain('<script>alert(1)</script>');
    expect(element.textContent).toContain('<b>b</b>');
  });

  it('drops javascript:, data:, file:, and obfuscated unsafe links but keeps their text', async () => {
    const element = await render(
      [
        '[a](javascript:alert(1))',
        '[b](JaVaScRiPt:alert(1))',
        '[c](data:text/html;base64,PHNjcmlwdD4=)',
        '[d](file:///etc/passwd)',
        '[e](java&#x09;script:alert(1))',
        '[f](java\tscript:alert(1))',
        '![img](https://example.com/x.png)',
        '<javascript:alert(1)>'
      ].join('\n\n')
    );
    for (const anchor of element.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(
        /^(?:javascript|data|file|vbscript):/iu
      );
    }
    // The first four keep only their text; the entity-obfuscated one stays a literal, harmless
    // relative path (the entity is not decoded into a tab); the bare autolink stays text.
    expect([...element.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual(['e']);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('java&#x09;script:alert(1)');
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain('img');
    expect(element.innerHTML).not.toMatch(/onerror|onclick/iu);
  });
});
