import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AudioPlayer from '../../../src/client/components/media/AudioPlayer.vue';
import type { GeneratedSpeech } from '../../../src/shared/read-text';

/**
 * An MP3 result, as the endpoint returns it.
 */
const MP3: GeneratedSpeech = {
  base64: 'SUQzAwA=',
  mediaType: 'audio/mpeg',
  byteLength: 2_048
};

/**
 * Mounts the player.
 *
 * @param props Props to override.
 * @returns The mounted wrapper.
 */
function render(props: Partial<InstanceType<typeof AudioPlayer>['$props']> = {}) {
  return mount(AudioPlayer, {
    props: {
      speech: MP3,
      src: 'data:audio/mpeg;base64,SUQzAwA=',
      text: 'Hello there.',
      runId: 'run-1',
      ...props
    }
  });
}

describe('the audio element', () => {
  // Native controls rather than custom transport buttons: already keyboard-operable, announced
  // correctly by screen readers, and honouring the system media keys. A hand-rolled player has to
  // add all of that back and usually adds most of it.
  it('uses a native element with its own controls', () => {
    const audio = render().find('audio');

    expect(audio.exists()).toBe(true);
    expect(audio.attributes('controls')).toBeDefined();
  });

  it('plays from the supplied source', () => {
    expect(render().find('audio').attributes('src')).toBe('data:audio/mpeg;base64,SUQzAwA=');
  });

  it('preloads only the metadata', () => {
    expect(render().find('audio').attributes('preload')).toBe('metadata');
  });

  // A browser that cannot play the element gets a sentence naming the format rather than an empty
  // box, and the download link beside it still works.
  it('names the format in its fallback text', () => {
    expect(render().find('audio').text()).toContain('audio/mpeg');
  });
});

describe('the text alternative', () => {
  // The substance of this component rather than a decoration on it. Audio is the one output in this
  // demo that some visitors cannot perceive at all, so a panel whose only result is a player is a
  // panel they cannot use.
  it('renders the spoken text', () => {
    expect(render().find('.spoken-text').text()).toBe('Hello there.');
  });

  // A peer of the player, not hidden behind a disclosure, so the result is available in both forms
  // at once rather than one of them requiring a click.
  it('is not hidden behind a disclosure', () => {
    const wrapper = render();

    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.find('.alternative').isVisible()).toBe(true);
  });

  it('is a labelled region with a heading', () => {
    const wrapper = render();
    const section = wrapper.find('.alternative');

    expect(section.attributes('aria-labelledby')).toBe('spoken-text-heading');
    expect(wrapper.find('#spoken-text-heading').exists()).toBe(true);
  });

  // Punctuation and line structure are what the model reads for pacing, so collapsing them would
  // misrepresent what was actually spoken.
  it('preserves the passage\u2019s own line breaks', () => {
    const wrapper = render({ text: 'First line.\nSecond line.' });
    expect(wrapper.find('.spoken-text').text()).toContain('\n');
  });
});

describe('the download', () => {
  it('names the file from the run identifier and the format', () => {
    expect(render().find('.download').attributes('download')).toBe('playground-run-1.mp3');
  });

  it('uses the wav extension for wav audio', () => {
    const wrapper = render({
      speech: { base64: 'UklGRg==', mediaType: 'audio/wav', byteLength: 4_096 }
    });

    expect(wrapper.find('.download').attributes('download')).toBe('playground-run-1.wav');
  });

  // A file name derived from user content is a path-traversal and header-injection surface for no
  // real benefit, so the spoken text is never used to build one.
  it('never derives the file name from the spoken text', () => {
    const wrapper = render({ text: '../../etc/passwd' });
    expect(wrapper.find('.download').attributes('download')).toBe('playground-run-1.mp3');
  });

  it('downloads the same bytes the player uses', () => {
    const wrapper = render();
    expect(wrapper.find('.download').attributes('href')).toBe(
      wrapper.find('audio').attributes('src')
    );
  });
});

describe('the reported facts', () => {
  it('states the format and size', () => {
    const text = render().text();

    expect(text).toContain('audio/mpeg');
    expect(text).toMatch(/2(\.0)? KB|2,048/u);
  });

  // Shown only when it is known. An absent duration is rendered as absent rather than as a zero or
  // a placeholder, because a wrong duration beside a player that disagrees is worse than none.
  it('omits the duration when none is known', () => {
    expect(render().text()).not.toMatch(/Duration/u);
  });

  it('shows a duration the server could read from the container', () => {
    const wrapper = render({ durationSeconds: 95 });

    expect(wrapper.text()).toMatch(/Duration/u);
    expect(wrapper.text()).toContain('1:35');
  });

  it('pads the seconds to two digits', () => {
    expect(render({ durationSeconds: 65 }).text()).toContain('1:05');
  });

  // A rounding that carries into the minute, so 119.7 seconds reads as 2:00 rather than the
  // nonsensical 1:60.
  it('carries a rounded minute rather than showing sixty seconds', () => {
    const text = render({ durationSeconds: 119.7 }).text();

    expect(text).toContain('2:00');
    expect(text).not.toContain('1:60');
  });

  it('shows a sub-minute duration', () => {
    expect(render({ durationSeconds: 3.2 }).text()).toContain('0:03');
  });

  // `Infinity` for a stream of unknown length and `NaN` before metadata is parsed. Neither is a
  // duration, and both would render as nonsense.
  it('ignores a non-finite duration', () => {
    expect(render({ durationSeconds: Number.POSITIVE_INFINITY }).text()).not.toMatch(/Duration/u);
    expect(render({ durationSeconds: Number.NaN }).text()).not.toMatch(/Duration/u);
  });
});
