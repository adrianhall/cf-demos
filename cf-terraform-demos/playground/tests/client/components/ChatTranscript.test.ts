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
    expect(wrapper.findAll('li')[1]?.text()).toContain('Playground');
  });

  // The growing answer itself stays quiet: putting it in a live region would re-announce the whole
  // accumulated response on every stream delta and flood the speech queue.
  it('keeps the transcript out of the live regions', () => {
    const list = mountTranscript([turn()]).find('ol');
    expect(list.attributes('aria-live')).toBeUndefined();
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

  it('announces when an answer has finished', () => {
    const wrapper = mountTranscript([turn({ id: 'b', role: 'assistant', content: 'done' })]);
    const status = wrapper.find('[role="status"]');
    expect(status.text()).toBe('Answer complete.');
  });

  // A failed run leaves an empty assistant turn. Saying so is better than an empty box the visitor
  // reads as a rendering fault.
  it('explains an assistant turn that produced no text', () => {
    const wrapper = mountTranscript([turn({ id: 'b', role: 'assistant', content: '' })]);
    expect(wrapper.text()).toContain('No answer was generated.');
  });

  // Assistant output is Markdown, but its raw HTML is still untrusted and passes through the
  // dedicated parser/sanitizer boundary.
  it('renders assistant Markdown without executable markup', () => {
    const wrapper = mountTranscript([
      turn({
        id: 'b',
        role: 'assistant',
        content: '**safe** <script>alert(1)</script>'
      })
    ]);

    expect(wrapper.find('strong').text()).toBe('safe');
    expect(wrapper.find('script').exists()).toBe(false);
  });

  // User input remains escaped plain text. Markdown is a model-output presentation capability, not
  // a route for a visitor's own message to become active HTML.
  it('renders user content as text rather than Markdown or HTML', () => {
    const wrapper = mountTranscript([
      turn({ content: '**not bold** <script>alert(1)</script>', role: 'user' })
    ]);

    expect(wrapper.find('strong').exists()).toBe(false);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('**not bold** <script>alert(1)</script>');
  });

  it('renders line breaks from assistant Markdown', () => {
    const wrapper = mountTranscript([
      turn({ id: 'b', role: 'assistant', content: 'line one\nline two' })
    ]);
    expect(wrapper.find('.markdown br').exists()).toBe(true);
  });

  // A list rather than a run of divs, so a screen reader announces how many turns there are and
  // lets the user step through them.
  it('uses a list so the turn count is conveyed', () => {
    const wrapper = mountTranscript([turn({ id: 'a' }), turn({ id: 'b' })]);
    expect(wrapper.find('ol').exists()).toBe(true);
    expect(wrapper.findAll('ol > li')).toHaveLength(2);
  });
});
