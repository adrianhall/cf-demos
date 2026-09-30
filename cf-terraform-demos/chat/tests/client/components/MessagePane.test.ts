import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mount } from '@vue/test-utils';
import type { ChatMessage } from '../../../src/chat-protocol';
import MessagePane from '../../../src/client/components/MessagePane.vue';
import type { RoomStatus } from '../../../src/client/stores/room';

const vuetify = createVuetify({ components });

/**
 * Build a message as the room broadcasts one.
 *
 * @param id Message identifier.
 * @param author Verified identity that wrote it.
 * @param body Message text.
 * @returns A complete message.
 */
function message(id: number, author: string, body: string): ChatMessage {
  return { id, author, body, createdAt: '2026-01-01T09:30:00.000Z' };
}

/**
 * Mount the pane.
 *
 * @param props Overrides for the pane's properties.
 * @returns The mounted wrapper.
 */
function mountPane(
  props: Partial<{
    messages: ChatMessage[];
    participants: number;
    status: RoomStatus;
    currentUserEmail: string | null;
  }> = {}
) {
  return mount(MessagePane, {
    global: { plugins: [vuetify] },
    props: {
      messages: [],
      participants: 1,
      status: 'connected' as RoomStatus,
      currentUserEmail: 'alice@example.com',
      ...props
    }
  });
}

describe('MessagePane', () => {
  it('shows an empty state before anything is said', () => {
    expect(mountPane().text()).toContain('No messages yet');
  });

  it('renders each message with its author', () => {
    const wrapper = mountPane({
      messages: [message(1, 'alice@example.com', 'morning'), message(2, 'bob@example.com', 'hello')]
    });

    expect(wrapper.text()).toContain('alice@example.com');
    expect(wrapper.text()).toContain('morning');
    expect(wrapper.text()).toContain('bob@example.com');
    expect(wrapper.text()).toContain('hello');
  });

  // Presentation only. Authorship is decided server-side; this styling just helps a reader scan
  // their own messages.
  it('marks only the reader’s own messages as theirs', () => {
    const wrapper = mountPane({
      messages: [message(1, 'alice@example.com', 'mine'), message(2, 'bob@example.com', 'theirs')],
      currentUserEmail: 'alice@example.com'
    });

    const articles = wrapper.findAll('article');
    expect(articles[0]?.classes()).toContain('own');
    expect(articles[1]?.classes()).not.toContain('own');
  });

  it('marks nothing as the reader’s own before the identity is known', () => {
    const wrapper = mountPane({
      messages: [message(1, 'alice@example.com', 'hello')],
      currentUserEmail: null
    });

    expect(wrapper.find('article').classes()).not.toContain('own');
  });

  it.each([
    [1, '1 participant'],
    [0, '0 participants'],
    [3, '3 participants']
  ])('pluralizes a count of %i correctly', (participants, expected) => {
    expect(mountPane({ participants }).text()).toContain(expected);
  });

  // A gap in delivery should explain itself rather than leaving the pane looking simply quiet.
  it.each([
    ['connecting' as RoomStatus, 'Connecting'],
    ['reconnecting' as RoomStatus, 'Connection lost']
  ])('explains the %s state', (status, expected) => {
    expect(mountPane({ status }).text()).toContain(expected);
  });

  it('shows no connection notice while connected', () => {
    expect(mountPane({ status: 'connected' }).find('.connection-notice').exists()).toBe(false);
  });

  // `role="log"` with polite announcements is the correct politeness for an ongoing
  // conversation: new messages are announced without interrupting current speech.
  it('announces new messages politely to assistive technology', () => {
    const region = mountPane().find('[role="log"]');

    expect(region.exists()).toBe(true);
    expect(region.attributes('aria-live')).toBe('polite');
  });

  it('exposes the message timestamp as machine-readable', () => {
    const wrapper = mountPane({ messages: [message(1, 'alice@example.com', 'hello')] });

    expect(wrapper.find('time').attributes('datetime')).toBe('2026-01-01T09:30:00.000Z');
  });

  // The renderer escapes content, so markup in a message is shown as text rather than parsed.
  it('renders message text without interpreting markup', () => {
    const wrapper = mountPane({
      messages: [message(1, 'alice@example.com', '<script>alert(1)</script>')]
    });

    expect(wrapper.text()).toContain('<script>alert(1)</script>');
    expect(wrapper.find('.message-body').element.querySelector('script')).toBeNull();
  });
});
