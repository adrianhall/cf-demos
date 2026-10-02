import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TranscriptView from '../../../src/client/components/results/TranscriptView.vue';
import type { Transcript, VerifiedAudioFacts } from '../../../src/shared/transcribe-audio';

/**
 * A transcript with phrase timings and log-probability figures, as Whisper turbo returns.
 */
const LOG_PROB: Transcript = {
  text: 'Hello there. This is a test.',
  spans: [
    { text: 'Hello there.', startSeconds: 0, endSeconds: 1.4, confidence: -0.21 },
    { text: 'This is a test.', startSeconds: 1.4, endSeconds: 3.2, confidence: -0.35 }
  ],
  timestampGranularity: 'segment',
  confidenceScale: 'log-probability',
  wordCount: 6,
  diarized: false
};

/**
 * A transcript with per-word timings and genuine probabilities, as Nova 3 returns.
 */
const PROBABILITY: Transcript = {
  text: 'Hello there',
  spans: [
    { text: 'Hello', startSeconds: 0, endSeconds: 0.5, confidence: 0.99, speaker: 0 },
    { text: 'there', startSeconds: 0.5, endSeconds: 0.9, confidence: 0.94, speaker: 1 }
  ],
  timestampGranularity: 'word',
  confidenceScale: 'probability',
  wordCount: 2,
  diarized: true
};

/**
 * The verified audio facts accompanying a transcript.
 */
const AUDIO: VerifiedAudioFacts = { mediaType: 'audio/mpeg', byteLength: 2_048 };

/**
 * Mounts the component.
 *
 * @param transcript Transcript to render.
 * @param audio Audio facts to render.
 * @returns The mounted wrapper.
 */
function render(transcript: Transcript = LOG_PROB, audio: VerifiedAudioFacts = AUDIO) {
  return mount(TranscriptView, { props: { transcript, audio, runId: 'run-1' } });
}

describe('the primary transcript', () => {
  // The text comes first because it is the result; the spans are a view of it. That ordering is
  // also what keeps the panel usable when a model returns no timings at all.
  it('renders the full text', () => {
    expect(render().find('.text').text()).toBe('Hello there. This is a test.');
  });

  it('reports the word count and audio facts', () => {
    const text = render().text();

    expect(text).toContain('6');
    expect(text).toContain('audio/mpeg');
  });

  it('shows a duration when the server established one', () => {
    const wrapper = render(LOG_PROB, { ...AUDIO, durationSeconds: 95 });

    expect(wrapper.text()).toContain('Duration');
    expect(wrapper.text()).toContain('1:35');
  });

  // Absent rather than shown as zero: a compressed file has no readable duration, and a zero
  // would be a claim rather than an absence.
  it('omits the duration when none was established', () => {
    expect(render().text()).not.toContain('Duration');
  });

  it('shows a detected language when the model reported one', () => {
    const wrapper = render({ ...LOG_PROB, detectedLanguage: 'en' });

    expect(wrapper.text()).toContain('Language');
    expect(wrapper.text()).toContain('en');
  });
});

describe('the timed breakdown', () => {
  it('renders one row per span with its timestamp', () => {
    const rows = render().findAll('tbody tr');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain('0:00');
    expect(rows[1]?.text()).toContain('0:01');
  });

  it('names the granularity so the rows are legible', () => {
    expect(render().text()).toContain('per phrase');
    expect(render(PROBABILITY).text()).toContain('per word');
  });

  it('shows a speaker column only when the transcript is diarized', () => {
    expect(render(PROBABILITY).text()).toContain('Speaker');
    expect(render().text()).not.toContain('Speaker');
  });

  // Said plainly rather than left as an empty space. A model returning no timings is a contract
  // difference worth knowing about, not a loading failure.
  it('explains when a model returned no timings at all', () => {
    const wrapper = render({ ...LOG_PROB, spans: [], timestampGranularity: undefined });

    expect(wrapper.find('tbody').exists()).toBe(false);
    expect(wrapper.text()).toMatch(/no timing information/iu);
  });

  // A real table so a screen reader announces the column for each cell, which a stack of divs
  // cannot do.
  it('uses a table with scoped headers and a caption', () => {
    const wrapper = render();

    expect(wrapper.find('table caption').exists()).toBe(true);
    for (const header of wrapper.findAll('thead th')) {
      expect(header.attributes('scope')).toBe('col');
    }
  });
});

describe('the confidence column', () => {
  // The disclosure this panel turns on. Two models report a number and mean different things by
  // it, and drawing both as one bar would be a fabrication.
  it('draws a bar only for a genuine probability', () => {
    expect(render(PROBABILITY).find('.bar').exists()).toBe(true);
    expect(render().find('.bar').exists()).toBe(false);
  });

  it('shows the raw log probability with no bar', () => {
    const wrapper = render();

    expect(wrapper.text()).toContain('-0.21');
    expect(wrapper.find('.bar-fill').exists()).toBe(false);
  });

  it('labels the column differently for each scale', () => {
    expect(render(PROBABILITY).find('thead').text()).toContain('Confidence');
    expect(render().find('thead').text()).toContain('log prob');
  });

  // "Confidence" is exactly the word a visitor reads as "chance of being right", and for one of
  // the two scales that is not what it is.
  it('explains that a log probability is not a percentage', () => {
    expect(render().text()).toMatch(/cannot be read as a percentage/iu);
  });

  it('explains that a probability is not a chance of being correct', () => {
    expect(render(PROBABILITY).text()).toMatch(/not a probability that the word is correct/iu);
  });

  it('omits the column entirely when the model reports no figures', () => {
    const noScores: Transcript = {
      ...LOG_PROB,
      spans: [{ text: 'Hello', startSeconds: 0, endSeconds: 1 }],
      confidenceScale: undefined
    };

    expect(render(noScores).find('thead').text()).not.toMatch(/confidence|log prob/iu);
  });
});

describe('copy and download', () => {
  it('copies only the transcript text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await render().find('.action').trigger('click');

    // Timestamps interleaved into a paste would have to be deleted by hand; the download is where
    // the full form lives.
    expect(writeText).toHaveBeenCalledWith('Hello there. This is a test.');
  });

  it('names the download from the run identifier', () => {
    expect(render().find('a.action').attributes('download')).toBe('transcript-run-1.txt');
  });

  // A file name derived from model output is a path-traversal and header-injection surface for no
  // real benefit.
  it('never derives the file name from the transcript', () => {
    const nasty = render({ ...LOG_PROB, text: '../../etc/passwd' });

    expect(nasty.find('a.action').attributes('download')).toBe('transcript-run-1.txt');
  });

  it('includes the timed breakdown in the download', () => {
    const href = render().find('a.action').attributes('href') ?? '';
    const decoded = decodeURIComponent(href.replace('data:text/plain;charset=utf-8,', ''));

    expect(decoded).toContain('Hello there. This is a test.');
    expect(decoded).toContain('[0:00]');
  });

  it('includes speaker labels in the download when diarized', () => {
    const href = render(PROBABILITY).find('a.action').attributes('href') ?? '';
    const decoded = decodeURIComponent(href.replace('data:text/plain;charset=utf-8,', ''));

    expect(decoded).toContain('[Speaker 0]');
  });

  // A naive `btoa` would throw on any character outside Latin-1, which is most of the languages
  // these models support — so the download would simply fail for them.
  it('survives a non-Latin transcript', () => {
    const wrapper = render({ ...LOG_PROB, text: 'こんにちは、世界' });
    const href = wrapper.find('a.action').attributes('href') ?? '';

    expect(decodeURIComponent(href.replace('data:text/plain;charset=utf-8,', ''))).toContain(
      'こんにちは、世界'
    );
  });
});
