/**
 * @file Tests for the generated-track player. The keyboard assertions are the substance: a music
 *   track is long enough that seeking matters, so this component adds real transport controls on
 *   top of the native element — and the one thing it must _not_ do is override the native element's
 *   own keyboard handling. Both directions are asserted, because a shortcut handler that fired for
 *   every keypress would pass a test that only checked the shortcuts worked. The lyrics assertions
 *   cover three states rather than two. Lyrics shown, an instrumental track, and a model-written
 *   track whose words were never returned are three different facts, and an empty panel would
 *   represent none of them.
 */

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TrackPlayer from '../../../src/client/components/media/TrackPlayer.vue';
import type { GeneratedTrack } from '../../../src/shared/generate-music';

/**
 * An MP3 track, as the endpoint returns one.
 */
const MP3: GeneratedTrack = {
  base64: 'SUQzAwA=',
  mediaType: 'audio/mpeg',
  byteLength: 2_048,
  sourceHost: 'examples.aig.cloudflare.com'
};

/**
 * Mounts the player.
 *
 * @param props Props to override.
 * @returns The mounted wrapper.
 */
function render(props: Partial<InstanceType<typeof TrackPlayer>['$props']> = {}) {
  return mount(TrackPlayer, {
    props: {
      track: MP3,
      src: 'data:audio/mpeg;base64,SUQzAwA=',
      prompt: 'ambient piano',
      runId: 'run-1',
      lyricsSource: 'none' as const,
      ...props
    },
    // Attached so the audio element behaves like a real one for the transport assertions: a
    // detached element reports no duration and ignores `currentTime`.
    attachTo: document.body
  });
}

/**
 * Prepares the mounted audio element so the transport controls have something to act on.
 *
 * `jsdom` does not decode media, so `duration` and `currentTime` are stubbed. Defining them is what
 * lets the clamping logic be exercised — the thing worth testing is that a skip stays inside the
 * track, which needs a track length to stay inside of.
 *
 * @param element The mounted audio element.
 * @param durationSeconds Duration the element should report.
 * @returns A reader for the element's current position.
 */
function stubMedia(element: HTMLAudioElement, durationSeconds = 60): { position: () => number } {
  let currentTime = 0;

  Object.defineProperty(element, 'duration', {
    configurable: true,
    get: () => durationSeconds
  });
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    }
  });

  return { position: () => currentTime };
}

describe('the audio element', () => {
  // Native controls rather than a fully hand-rolled transport: already keyboard-operable, announced
  // correctly by screen readers, and honouring the system media keys.
  it('uses a native element with its own controls', () => {
    const audio = render().find('audio');

    expect(audio.exists()).toBe(true);
    expect(audio.attributes('controls')).toBeDefined();
  });

  it('plays from the supplied source and preloads only metadata', () => {
    const audio = render().find('audio');

    expect(audio.attributes('src')).toBe('data:audio/mpeg;base64,SUQzAwA=');
    expect(audio.attributes('preload')).toBe('metadata');
  });

  // The prompt becomes the accessible name, so a screen-reader user hears which track this player
  // holds rather than "audio".
  it('names the player with the prompt that produced the track', () => {
    expect(render().find('audio').attributes('aria-label')).toBe(
      'Generated track for: ambient piano'
    );
  });

  it('names the format in its fallback text', () => {
    expect(render().find('audio').text()).toContain('audio/mpeg');
  });
});

describe('the transport controls', () => {
  it('offers restart, back, and forward as real buttons', () => {
    const wrapper = render();

    for (const control of ['restart', 'back', 'forward']) {
      const button = wrapper.find(`[data-transport="${control}"]`);
      expect(button.exists(), control).toBe(true);
      // A `<button>` rather than a clickable div, so it is focusable and activated by Enter and
      // Space without this component adding either back.
      expect(button.element.tagName, control).toBe('BUTTON');
      expect(button.attributes('type'), control).toBe('button');
    }
  });

  it('labels the transport group for assistive technology', () => {
    expect(render().find('[role="group"]').attributes('aria-label')).toBe('Track transport');
  });

  it('skips forward and back by ten seconds', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement);

    await wrapper.find('[data-transport="forward"]').trigger('click');
    expect(media.position()).toBe(10);

    await wrapper.find('[data-transport="forward"]').trigger('click');
    expect(media.position()).toBe(20);

    await wrapper.find('[data-transport="back"]').trigger('click');
    expect(media.position()).toBe(10);
  });

  it('returns to the start', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement);

    await wrapper.find('[data-transport="forward"]').trigger('click');
    await wrapper.find('[data-transport="restart"]').trigger('click');

    expect(media.position()).toBe(0);
  });

  // Clamped at both ends rather than left to the element: seeking past the end restarts playback in
  // some browsers, and a negative time is simply invalid.
  it('clamps a skip to the bounds of the track', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement, 15);

    await wrapper.find('[data-transport="back"]').trigger('click');
    expect(media.position()).toBe(0);

    await wrapper.find('[data-transport="forward"]').trigger('click');
    await wrapper.find('[data-transport="forward"]').trigger('click');
    expect(media.position()).toBe(15);
  });
});

describe('the keyboard shortcuts', () => {
  it('skips with the arrow keys', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement);

    await wrapper.find('.track-player').trigger('keydown', { key: 'ArrowRight' });
    expect(media.position()).toBe(10);

    await wrapper.find('.track-player').trigger('keydown', { key: 'ArrowLeft' });
    expect(media.position()).toBe(0);
  });

  it('restarts with Home', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement);

    await wrapper.find('.track-player').trigger('keydown', { key: 'ArrowRight' });
    await wrapper.find('.track-player').trigger('keydown', { key: 'Home' });

    expect(media.position()).toBe(0);
  });

  it('plays and pauses with k', async () => {
    const wrapper = render();
    const element = wrapper.find('audio').element as HTMLAudioElement;
    stubMedia(element);

    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    Object.defineProperty(element, 'play', { configurable: true, value: play });
    Object.defineProperty(element, 'pause', { configurable: true, value: pause });
    Object.defineProperty(element, 'paused', {
      configurable: true,
      get: () => play.mock.calls.length === 0
    });

    await wrapper.find('.track-player').trigger('keydown', { key: 'k' });
    expect(play).toHaveBeenCalledOnce();

    await wrapper.find('.track-player').trigger('keydown', { key: 'k' });
    expect(pause).toHaveBeenCalledOnce();
  });

  // The important negative. The browser's own arrow-key seeking has to keep working when the native
  // control has focus; reimplementing it there would replace a well-tested behaviour with a worse
  // one.
  it('leaves the native element\u2019s own keyboard handling alone', async () => {
    const wrapper = render();
    const element = wrapper.find('audio').element as HTMLAudioElement;
    const media = stubMedia(element);

    await wrapper.find('audio').trigger('keydown', { key: 'ArrowRight' });

    expect(media.position()).toBe(0);
  });

  // Space is deliberately not bound: it is how a keyboard user activates the focused button, and
  // stealing it would break the three skip controls beside the player.
  it('does not bind Space', async () => {
    const wrapper = render();
    const element = wrapper.find('audio').element as HTMLAudioElement;
    stubMedia(element);
    const play = vi.fn(async () => undefined);
    Object.defineProperty(element, 'play', { configurable: true, value: play });
    Object.defineProperty(element, 'paused', { configurable: true, get: () => true });

    await wrapper.find('.track-player').trigger('keydown', { key: ' ' });

    expect(play).not.toHaveBeenCalled();
  });

  it('ignores a key it does not handle', async () => {
    const wrapper = render();
    const media = stubMedia(wrapper.find('audio').element as HTMLAudioElement);

    await wrapper.find('.track-player').trigger('keydown', { key: 'q' });

    expect(media.position()).toBe(0);
  });

  // A shortcut nobody knows about is a shortcut nobody uses, and the sentence is also where the
  // absent Space binding is explained rather than left to look like an oversight.
  it('states the shortcuts, including what Space does not do', () => {
    const text = render().find('.shortcuts').text();

    expect(text).toMatch(/Home/u);
    expect(text).toMatch(/\bk\b/u);
    expect(text).toMatch(/space is left to the buttons/iu);
  });
});

describe('the lyrics', () => {
  it('renders supplied lyrics as a peer of the player', () => {
    const wrapper = render({ lyricsSource: 'caller', lyrics: 'line one\nline two' });

    expect(wrapper.find('.lyrics-text').text()).toContain('line one');
    // Not hidden behind a disclosure: audio is the one output some visitors cannot perceive at all.
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.find('.lyrics').isVisible()).toBe(true);
  });

  // Line structure is the shape of a verse, so collapsing it would misrepresent what was sung.
  it('preserves the lyric line breaks', () => {
    const wrapper = render({ lyricsSource: 'caller', lyrics: 'line one\nline two' });
    expect(wrapper.find('.lyrics-text').text()).toContain('\n');
  });

  it('is a labelled region with a heading', () => {
    const wrapper = render({ lyricsSource: 'caller', lyrics: 'line one' });

    expect(wrapper.find('.lyrics').attributes('aria-labelledby')).toBe('track-lyrics-heading');
    expect(wrapper.find('#track-lyrics-heading').exists()).toBe(true);
  });

  it('says plainly that an instrumental track has none', () => {
    expect(render({ lyricsSource: 'none' }).find('.lyrics-note').text()).toMatch(
      /instrumental track, so there are no lyrics/iu
    );
  });

  // The case an empty panel would misrepresent. A model that wrote its own words returns audio and
  // nothing else, which is a contract fact rather than a rendering fault.
  it('explains that model-written lyrics were not returned', () => {
    const note = render({ lyricsSource: 'model' }).find('.lyrics-note').text();

    expect(note).toMatch(/wrote the lyrics/iu);
    expect(note).toMatch(/charged separately/iu);
    expect(note).toMatch(/nothing to print/iu);
  });
});

describe('the reported facts', () => {
  it('states the format and size', () => {
    const text = render().text();

    expect(text).toContain('audio/mpeg');
    expect(text).toMatch(/2(\.0)? KB|2,048/u);
  });

  // Shown only when it is known. An absent length is rendered as absent rather than as a zero: on
  // this panel a wrong number sits next to a per-second price.
  it('omits the length when none is known', () => {
    expect(render().text()).not.toMatch(/Length/u);
  });

  it('shows a length the server read from the container', () => {
    const wrapper = render({
      track: { ...MP3, mediaType: 'audio/wav', durationSeconds: 95 }
    });

    expect(wrapper.text()).toMatch(/Length/u);
    expect(wrapper.text()).toContain('1:35');
  });

  it('pads the seconds and carries a rounded minute', () => {
    expect(render({ track: { ...MP3, durationSeconds: 65 } }).text()).toContain('1:05');
    const carried = render({ track: { ...MP3, durationSeconds: 119.7 } }).text();
    expect(carried).toContain('2:00');
    expect(carried).not.toContain('1:60');
  });

  it('ignores a non-finite length', () => {
    expect(
      render({ track: { ...MP3, durationSeconds: Number.POSITIVE_INFINITY } }).text()
    ).not.toMatch(/Length/u);
    expect(render({ track: { ...MP3, durationSeconds: Number.NaN } }).text()).not.toMatch(
      /Length/u
    );
  });
});

describe('the download', () => {
  it('names the file from the run identifier and the format', () => {
    expect(render().find('.download').attributes('download')).toBe('playground-track-run-1.mp3');
  });

  it('uses the wav extension for wav audio', () => {
    const wrapper = render({ track: { ...MP3, mediaType: 'audio/wav' } });
    expect(wrapper.find('.download').attributes('download')).toBe('playground-track-run-1.wav');
  });

  // A file name derived from user content is a path-traversal and header-injection surface for no
  // real benefit, so neither the prompt nor the lyrics is used to build one.
  it('never derives the file name from the prompt or the lyrics', () => {
    const wrapper = render({
      prompt: '../../etc/passwd',
      lyricsSource: 'caller',
      lyrics: '../../etc/shadow'
    });

    expect(wrapper.find('.download').attributes('download')).toBe('playground-track-run-1.mp3');
  });

  it('downloads the same bytes the player uses', () => {
    const wrapper = render();
    expect(wrapper.find('.download').attributes('href')).toBe(
      wrapper.find('audio').attributes('src')
    );
  });
});
