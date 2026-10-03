import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TranslationView from '../../../src/client/components/results/TranslationView.vue';
import type { Translation } from '../../../src/shared/translate-text';

/**
 * A translation with an internal blank line, which is the structure worth asserting on.
 */
const TRANSLATION: Translation = {
  text: 'un\n\ntrois',
  segments: [
    { source: 'one', translated: 'un', blank: false },
    { source: '', translated: '', blank: true },
    { source: 'three', translated: 'trois', blank: false }
  ],
  translatedLineCount: 2,
  inferenceCallCount: 2
};

/**
 * Mounts the component.
 *
 * @param translation Translation to render.
 * @param overrides Props to replace.
 * @returns The mounted wrapper.
 */
function render(translation: Translation = TRANSLATION, overrides: Record<string, unknown> = {}) {
  return mount(TranslationView, {
    props: {
      translation,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      sourceLanguageName: 'English',
      targetLanguageName: 'French',
      runId: 'run-1',
      ...overrides
    }
  });
}

describe('the aligned columns', () => {
  it('renders one row per segment', () => {
    expect(render().findAll('tbody tr')).toHaveLength(3);
  });

  // The alignment is the point of the component: a line on the left is always the line that
  // produced the one beside it.
  it('pairs each source line with its own translation', () => {
    const cells = render()
      .findAll('tbody tr')
      .map((row) => row.findAll('td').map((cell) => cell.text()));

    expect(cells[0]?.[0]).toContain('one');
    expect(cells[0]?.[1]).toContain('un');
    expect(cells[2]?.[0]).toContain('three');
    expect(cells[2]?.[1]).toContain('trois');
  });

  it('names both languages as column headings', () => {
    const headers = render()
      .findAll('thead th')
      .map((h) => h.text());
    expect(headers).toEqual(['English', 'French']);
  });

  // A real table so a screen reader announces the column for each cell, which a pair of floated
  // columns cannot do.
  it('uses a table with scoped headers and a caption', () => {
    const wrapper = render();

    expect(wrapper.find('table caption').exists()).toBe(true);
    for (const header of wrapper.findAll('thead th')) {
      expect(header.attributes('scope')).toBe('col');
    }
  });

  // On a narrow screen the rows stack, and without a per-cell label a stacked row reads as
  // alternating fragments of two languages with no indication of which is which.
  it('labels every cell for the stacked layout', () => {
    const firstRow = render().findAll('tbody tr')[0];
    const hidden = firstRow?.findAll('.visually-hidden').map((s) => s.text()) ?? [];

    expect(hidden.join(' ')).toContain('English');
    expect(hidden.join(' ')).toContain('French');
  });
});

describe('language annotation', () => {
  // The attribute that makes this panel usable with a screen reader at all: without it a
  // synthesiser reads Hindi with English pronunciation rules.
  it('marks the translated cells with the target language', () => {
    const cells = render(TRANSLATION, { targetLanguage: 'hi' })
      .findAll('tbody tr')
      .map((row) => row.findAll('td')[1]?.attributes('lang'));

    expect(new Set(cells)).toEqual(new Set(['hi']));
  });

  it('marks the source cells with the source language', () => {
    const cell = render().findAll('tbody tr')[0]?.findAll('td')[0];
    expect(cell?.attributes('lang')).toBe('en');
  });
});

describe('blank lines', () => {
  // The structure this panel promises to preserve, so it has to be visible rather than collapsed
  // into a zero-height row.
  it('renders a blank line as a visible gap', () => {
    expect(render().find('.row--blank').exists()).toBe(true);
    expect(render().find('.blank-marker').exists()).toBe(true);
  });

  // A screen reader reaching a silent row would have no idea why it was there.
  it('announces a blank line rather than leaving it silent', () => {
    const blankRow = render().findAll('tbody tr')[1];
    expect(blankRow?.text()).toContain('blank line');
  });

  it('renders no blank row for a translation that has none', () => {
    const flat: Translation = {
      text: 'un',
      segments: [{ source: 'one', translated: 'un', blank: false }],
      translatedLineCount: 1,
      inferenceCallCount: 1
    };

    expect(render(flat).find('.row--blank').exists()).toBe(false);
  });
});

describe('the run facts', () => {
  // The cost-shaped figure this panel exists to make visible.
  it('reports the lines translated and the calls they cost', () => {
    expect(render().text()).toContain('2 lines translated in 2 paid requests');
  });

  it('uses singular wording for a single line and call', () => {
    const single: Translation = {
      text: 'un',
      segments: [{ source: 'one', translated: 'un', blank: false }],
      translatedLineCount: 1,
      inferenceCallCount: 1
    };

    expect(render(single).text()).toContain('1 line translated in 1 paid request');
  });

  // The same line count costing a different number of calls is the comparison the panel is for.
  it('reports a batched run as a single request', () => {
    const batched: Translation = { ...TRANSLATION, inferenceCallCount: 1 };
    expect(render(batched).text()).toContain('2 lines translated in 1 paid request');
  });
});

describe('copy and download', () => {
  it('copies the assembled translation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await render().find('button.action').trigger('click');

    // The translation only, not the source: the source is text the visitor already has.
    expect(writeText).toHaveBeenCalledWith('un\n\ntrois');
  });

  it('names the download from the run identifier and target language', () => {
    expect(render().find('a.action').attributes('download')).toBe('translation-fr-run-1.txt');
  });

  // A file name derived from model output is a path-traversal and header-injection surface for no
  // real benefit.
  it('never derives the file name from the translation', () => {
    const nasty: Translation = { ...TRANSLATION, text: '../../etc/passwd' };

    expect(render(nasty).find('a.action').attributes('download')).toBe('translation-fr-run-1.txt');
  });

  it('downloads the translation with its line structure', () => {
    const href = render().find('a.action').attributes('href') ?? '';
    const decoded = decodeURIComponent(href.replace('data:text/plain;charset=utf-8,', ''));

    expect(decoded).toBe('un\n\ntrois');
  });

  // A naive `btoa` would throw on any character outside Latin-1 — which is *every* target language
  // one of this panel's two models offers. That would not be an edge case; it would be the normal
  // path.
  it('survives a translation in a non-Latin script', () => {
    const devanagari: Translation = {
      text: 'पानी ठंडा है',
      segments: [{ source: 'the water is cold', translated: 'पानी ठंडा है', blank: false }],
      translatedLineCount: 1,
      inferenceCallCount: 1
    };

    const href = render(devanagari).find('a.action').attributes('href') ?? '';
    expect(decodeURIComponent(href.replace('data:text/plain;charset=utf-8,', ''))).toContain(
      'पानी ठंडा है'
    );
  });
});
