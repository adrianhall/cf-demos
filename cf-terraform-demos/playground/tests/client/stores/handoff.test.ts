import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { truncateForSpeech, useHandoffStore } from '../../../src/client/stores/handoff';
import { MAX_SPEECH_CHARACTERS } from '../../../src/shared/read-text';

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
});

describe('truncating text for the speech panel', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncateForSpeech('short passage')).toEqual({
      text: 'short passage',
      truncated: false
    });
  });

  it('leaves text exactly at the limit untouched', () => {
    const exact = 'a'.repeat(MAX_SPEECH_CHARACTERS);
    expect(truncateForSpeech(exact)).toEqual({ text: exact, truncated: false });
  });

  it('shortens text beyond the limit and reports it', () => {
    const result = truncateForSpeech('a'.repeat(MAX_SPEECH_CHARACTERS + 100));

    expect(result.truncated).toBe(true);
    expect([...result.text].length).toBeLessThanOrEqual(MAX_SPEECH_CHARACTERS);
  });

  // The one place this truncation becomes audible rather than merely visible: a passage ending
  // mid-word is read aloud as a mispronounced fragment.
  it('cuts at a word boundary when one is available near the end', () => {
    const words = `${'word '.repeat(MAX_SPEECH_CHARACTERS / 5)}tail`;
    const result = truncateForSpeech(words);

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('word')).toBe(true);
    expect(result.text).not.toMatch(/\s$/u);
  });

  // A text with no spaces — or whose only space is in its first few words, as in some scripts —
  // would otherwise be cut to almost nothing in the name of tidiness.
  it('does not cut to a distant word boundary', () => {
    const result = truncateForSpeech(`a ${'b'.repeat(MAX_SPEECH_CHARACTERS + 100)}`);

    expect([...result.text].length).toBeGreaterThan(MAX_SPEECH_CHARACTERS * 0.9);
  });

  it('handles text with no spaces at all', () => {
    const result = truncateForSpeech('x'.repeat(MAX_SPEECH_CHARACTERS + 50));

    expect([...result.text].length).toBe(MAX_SPEECH_CHARACTERS);
  });

  // Counted in code points, matching the server's limit, so the two cannot disagree about whether a
  // passage fits.
  it('counts a non-BMP character once', () => {
    const emoji = '\u{1F600}'.repeat(MAX_SPEECH_CHARACTERS);
    expect(truncateForSpeech(emoji).truncated).toBe(false);
  });
});

describe('the text handoff slot', () => {
  it('carries text, provenance, and a language', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'Bonjour', origin: 'Translated into French', language: 'fr' });

    expect(store.takeText()).toEqual({
      text: 'Bonjour',
      origin: 'Translated into French',
      language: 'fr',
      truncated: false
    });
  });

  // Truncating at the offering end means a caller cannot stage text the receiving panel would
  // refuse, which would otherwise arrive as a form invalid the moment it is populated.
  it('shortens an over-long offer and records that it did', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'a'.repeat(MAX_SPEECH_CHARACTERS + 10), origin: 'Translated' });

    const taken = store.takeText();
    expect(taken?.truncated).toBe(true);
    expect([...(taken?.text ?? '')].length).toBeLessThanOrEqual(MAX_SPEECH_CHARACTERS);
  });

  // Clearing on read is what makes this a handoff rather than a cache: returning to the panel later
  // must not silently reload a passage the visitor has moved on from.
  it('clears the slot on read', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'Bonjour', origin: 'Translated' });

    expect(store.takeText()).toBeDefined();
    expect(store.takeText()).toBeUndefined();
  });

  it('reports nothing when no text was offered', () => {
    expect(useHandoffStore().takeText()).toBeUndefined();
  });

  it('replaces a previous unclaimed offer', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'first', origin: 'One' });
    store.offerText({ text: 'second', origin: 'Two' });

    expect(store.takeText()?.text).toBe('second');
  });
});

describe('keeping the two handoff kinds separate', () => {
  // Separate slots rather than one union-typed slot. They are consumed by different panels, so a
  // single slot would mean an uncollected picture silently discarding a translation — a cross-panel
  // interaction with no reason to exist.
  it('does not let a text offer displace a pending picture', () => {
    const store = useHandoffStore();
    store.offer({
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 4,
      origin: 'Generated in Create Image'
    });
    store.offerText({ text: 'Bonjour', origin: 'Translated' });

    expect(store.take()?.origin).toBe('Generated in Create Image');
    expect(store.takeText()?.text).toBe('Bonjour');
  });

  it('does not let a picture offer displace pending text', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'Bonjour', origin: 'Translated' });
    store.offer({ base64: 'AAAA', mediaType: 'image/png', byteLength: 4, origin: 'Created' });

    expect(store.takeText()?.text).toBe('Bonjour');
    expect(store.take()?.origin).toBe('Created');
  });

  it('leaves text untouched when a picture is taken', () => {
    const store = useHandoffStore();
    store.offerText({ text: 'Bonjour', origin: 'Translated' });

    expect(store.take()).toBeUndefined();
    expect(store.takeText()?.text).toBe('Bonjour');
  });
});
