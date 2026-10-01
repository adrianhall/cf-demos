import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatTranscript from '../../../src/client/features/chat/ChatTranscript.vue';
import type { ConversationTurn } from '../../../src/client/features/chat/conversation';

/**
 * Builds a conversation turn.
 *
 * @param overrides Fields to replace on a completed user turn.
 * @returns A turn to render.
 */
function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return { id: 'turn-1', role: 'user', content: 'Hello', streaming: false, ...overrides };
}

/**
 * Mounts the transcript.
 *
 * @param turns Turns to render.
 * @returns The mounted wrapper.
 */
function mountTranscript(turns: ConversationTurn[]) {
  return mount(ChatTranscript, { props: { turns } });
}

describe('ChatTranscript', () => {
  it('renders nothing for an empty conversation', () => {
    expect(mountTranscript([]).find('ol').exists()).toBe(false);
  });

  it('renders each turn in order', () => {
    const wrapper = mountTranscript([
      turn({ id: 'a', content: 'first' }),
      turn({ id: 'b', role: 'assistant', content: 'second' })
    ]);

    const items = wrapper.findAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.text()).toContain('first');
    expect(items[1]?.text()).toContain('second');
  });

  // The speaker is a text label, not a colour or an alignment. A transcript that distinguishes
  // speakers only visually conveys nothing to a screen reader and nothing on a narrow viewport.
  it('names the speaker in text rather than by styling alone', () => {
    const wrapper = mountTranscript([
      turn({ id: 'a', content: 'q' }),
      turn({ id: 'b', role: 'assistant', content: 'a' })
    ]);

    expect(wrapper.findAll('li')[0]?.text()).toContain('You');
    expect(wrapper.findAll('li')[1]?.text()).toContain('Assistant');
  });

  // The region is announced as it grows, so a screen-reader user hears the answer arrive instead of
  // having to go looking for it. `polite` because interrupting on every delta would be unusable.
  it('announces new text politely as it streams', () => {
    const list = mountTranscript([turn()]).find('ol');
    expect(list.attributes('aria-live')).toBe('polite');
    // Only the added text is announced rather than the whole conversation being re-read.
    expect(list.attributes('aria-atomic')).toBe('false');
  });

  it('labels the transcript as a conversation', () => {
    expect(mountTranscript([turn()]).find('ol').attributes('aria-label')).toBe('Conversation');
  });

  it('shows a generating status on a streaming turn', () => {
    const wrapper = mountTranscript([
      turn({ id: 'b', role: 'assistant', content: 'partial', streaming: true })
    ]);
    expect(wrapper.text()).toContain('Generating…');
  });

  it('hides the streaming cursor from assistive technology', () => {
    const wrapper = mountTranscript([
      turn({ id: 'b', role: 'assistant', content: 'partial', streaming: true })
    ]);
    expect(wrapper.find('.cursor').attributes('aria-hidden')).toBe('true');
  });

  it('shows no generating status once a turn has finished', () => {
    const wrapper = mountTranscript([turn({ id: 'b', role: 'assistant', content: 'done' })]);
    expect(wrapper.text()).not.toContain('Generating…');
  });

  // A failed run leaves an empty assistant turn. Saying so is better than an empty box the visitor
  // reads as a rendering fault.
  it('explains an assistant turn that produced no text', () => {
    const wrapper = mountTranscript([turn({ id: 'b', role: 'assistant', content: '' })]);
    expect(wrapper.text()).toContain('No answer was generated.');
  });

  // Model output is rendered as text, not as HTML. Passing it through a Markdown renderer would be
  // an injection surface added for presentation alone.
  it('renders model output as text rather than markup', () => {
    const wrapper = mountTranscript([
      turn({ id: 'b', role: 'assistant', content: '<script>alert(1)</script>' })
    ]);

    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('<script>alert(1)</script>');
  });

  it('preserves the line breaks a model put in its answer', () => {
    const wrapper = mountTranscript([
      turn({ id: 'b', role: 'assistant', content: 'line one\nline two' })
    ]);
    expect(wrapper.find('.turn-text').text()).toContain('line one\nline two');
  });

  // A list rather than a run of divs, so a screen reader announces how many turns there are and
  // lets the user step through them.
  it('uses a list so the turn count is conveyed', () => {
    const wrapper = mountTranscript([turn({ id: 'a' }), turn({ id: 'b' })]);
    expect(wrapper.find('ol').exists()).toBe(true);
    expect(wrapper.findAll('ol > li')).toHaveLength(2);
  });
});
