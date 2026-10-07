import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateExportFilename, triggerDownload } from '../../src/client/lib/export.ts';

/**
 * @file Covers export filenames and the download they are handed to. A filename reaches a
 *   filesystem, and a diagram title is free text, so the cases that matter are the hostile ones:
 *   punctuation, path separators, and a title with nothing usable in it at all.
 */

/**
 * A fixed clock, so a name can be asserted exactly rather than matched loosely.
 */
const FIXED_NOW = new Date(2026, 0, 5, 9, 7);

describe('generateExportFilename', () => {
  it('stamps the title with the date and time', () => {
    expect(generateExportFilename('My Architecture', 'png', FIXED_NOW)).toBe(
      'My_Architecture_2026-01-05_0907.png'
    );
  });

  // Exporting the same diagram twice is the common case — after a change, to compare — and two
  // identically named files in a downloads folder are indistinguishable.
  it('distinguishes two exports of the same diagram taken minutes apart', () => {
    const first = generateExportFilename('Diagram', 'png', new Date(2026, 0, 5, 9, 7));
    const second = generateExportFilename('Diagram', 'png', new Date(2026, 0, 5, 9, 8));

    expect(first).not.toBe(second);
  });

  it.each([
    ['png' as const, '.png'],
    ['svg' as const, '.svg'],
    ['zip' as const, '.zip']
  ])('appends the %s extension', (format, extension) => {
    expect(generateExportFilename('Diagram', format, FIXED_NOW)).toMatch(
      new RegExp(`\\${extension}$`, 'u')
    );
  });

  it('collapses punctuation and repeated separators into single underscores', () => {
    expect(generateExportFilename('API  Gateway -- v2.0', 'svg', FIXED_NOW)).toBe(
      'API_Gateway_v2_0_2026-01-05_0907.svg'
    );
  });

  it('trims the underscores punctuation leaves at the edges', () => {
    expect(generateExportFilename('!!!Diagram!!!', 'zip', FIXED_NOW)).toBe(
      'Diagram_2026-01-05_0907.zip'
    );
  });

  // The reason sanitising is aggressive rather than selective: a title is free text and this
  // value reaches a filesystem.
  it.each([
    ['a path separator', 'reports/2026/final'],
    ['a parent-directory traversal', '../../etc/passwd'],
    ['a Windows-reserved character', 'before:after?maybe'],
    ['a leading dot', '.hidden']
  ])('neutralises %s', (_description, title) => {
    const filename = generateExportFilename(title, 'png', FIXED_NOW);

    expect(filename).not.toContain('/');
    expect(filename).not.toContain('\\');
    expect(filename).not.toContain('..');
    expect(filename.startsWith('.')).toBe(false);
    expect(filename).toMatch(/^[A-Za-z0-9_]+_\d{4}-\d{2}-\d{2}_\d{4}\.png$/u);
  });

  it.each([
    ['a blank title', '   '],
    ['an all-punctuation title', '!!!'],
    ['an empty title', '']
  ])('falls back to a usable name for %s', (_description, title) => {
    expect(generateExportFilename(title, 'png', FIXED_NOW)).toBe('diagram_2026-01-05_0907.png');
  });

  it('pads single-digit date and time components', () => {
    expect(generateExportFilename('Diagram', 'png', new Date(2026, 2, 3, 4, 5))).toBe(
      'Diagram_2026-03-03_0405.png'
    );
  });

  it('reads the real clock when none is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    expect(generateExportFilename('Diagram', 'png')).toBe('Diagram_2026-01-05_0907.png');

    vi.useRealTimers();
  });
});

describe('triggerDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks a download anchor carrying the url and filename', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const append = vi.spyOn(document.body, 'appendChild');

    triggerDownload('blob:generated', 'diagram.png');

    const anchor = append.mock.calls[0]?.[0] as HTMLAnchorElement;

    expect(anchor.href).toBe('blob:generated');
    expect(anchor.download).toBe('diagram.png');
    expect(click).toHaveBeenCalledTimes(1);
  });

  // The browser takes ownership of the download during the click, so leaving the anchor attached
  // would accumulate one dead element per export for the lifetime of the tab.
  it('leaves nothing behind in the document', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const before = document.body.childElementCount;

    triggerDownload('blob:generated', 'diagram.png');

    expect(document.body.childElementCount).toBe(before);
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
