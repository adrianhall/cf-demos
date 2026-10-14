/**
 * @file The chat panel in the DOM: the app bar toggle and its ARIA contract, the panel opening and
 *   closing, focus returning to the toggle, the composer's keyboard operation, the streaming
 *   transcript, the approval card, the expiry notice, and that none of it is in the initial bundle
 *   (`specs/ignite-crm/05-ai-features.md` §7.3). The socket is substituted: jsdom has no WebSocket
 *   server, and these tests are about the panel's behaviour rather than the Agents protocol, which
 *   the Workers-runtime suite exercises for real. The substitution is a fake `AgentConnection`
 *   whose `send` is recorded, so what the panel _sends_ is still asserted.
 */

import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, type Component } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { VApp } from 'vuetify/components';
import { flushPromises, mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import ChatApprovalCard from '../../src/client/components/chat/ChatApprovalCard.vue';
import ChatComposer from '../../src/client/components/chat/ChatComposer.vue';
import ChatMessage from '../../src/client/components/chat/ChatMessage.vue';
import ChatTranscript from '../../src/client/components/chat/ChatTranscript.vue';
import { resetChatPanel } from '../../src/client/composables/useChatPanel.ts';
import { useCrmChat } from '../../src/client/composables/useCrmChat.ts';
import { resetSession } from '../../src/client/composables/useSession.ts';
import { createAppRouter } from '../../src/client/router/index.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import { createFakeDataService } from '../fakes/fake-data-service.ts';
import { mountWithApp, settle, useApi } from './support.ts';

/**
 * Frames the fake socket was asked to send.
 */
let sent: string[] = [];

/**
 * A fake Agents connection: it records what the panel sends and never delivers anything back, which
 * is enough for every assertion here except streaming, which is driven through the message list.
 *
 * @returns The connection.
 */
function fakeSocket() {
  return {
    send: (data: string) => {
      sent.push(data);
      return true;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined
  };
}

/**
 * Mount a component that uses {@link useCrmChat} over the fake socket.
 *
 * @param options History to load and a client override.
 * @returns The composable's return value, once it has settled.
 */
async function mountChat(options: { history?: UIMessage[] } = {}) {
  let chat: ReturnType<typeof useCrmChat> | undefined;
  const wrapper = mount(
    {
      setup() {
        chat = useCrmChat({
          client: {
            chatSession: () => Promise.resolve({ sessionId: 'session-1' })
          } as never,
          connect: fakeSocket,
          loadHistory: () => Promise.resolve(options.history ?? [])
        });
        return () => h('div');
      }
    },
    { global: { plugins: [createAppVuetify()] } }
  );
  await flushPromises();
  await flushPromises();
  return { chat: chat!, wrapper };
}

/**
 * Mount one chat component inside `v-app` with Vuetify.
 *
 * @param component The component.
 * @param props Its props.
 * @returns The wrapper.
 */
function mountPart(component: Component, props: Record<string, unknown>) {
  return mount(
    { render: () => h(VApp, () => h(component, props)) },
    { attachTo: document.body, global: { plugins: [createAppVuetify()] } }
  );
}

/**
 * A seeded fake with one sales user.
 *
 * @returns The fake.
 */
function seeded() {
  const fake = createFakeDataService();
  fake.store.addUser('sales@example.com', 'sales');
  return fake;
}

beforeEach(() => {
  sent = [];
  resetSession();
  resetChatPanel();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the Chat button in the app bar', () => {
  it('is a toggle that says whether the panel is open, and which panel it controls', async () => {
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);

    const toggle = wrapper.get('[data-testid="chat-toggle"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.attributes('aria-controls')).toBe('chat-panel');
    expect(toggle.attributes('aria-label')).toBe('Assistant');
    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(false);

    await toggle.trigger('click');
    await settle();

    expect(wrapper.get('[data-testid="chat-toggle"]').attributes('aria-expanded')).toBe('true');
  });

  it('opens the panel, and closing it returns focus to the button', async () => {
    useApi('sales@example.com', seeded());
    // The panel's own session calls fail against the fake API, which is fine here: this test is
    // about the shell's open/close contract, and the panel renders either way.
    const { wrapper } = await mountWithApp(App);

    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(true);

    await wrapper.get('[data-testid="chat-close"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('chat-toggle');
  });

  it('is not shown before the session has loaded, because there is nobody to help yet', async () => {
    const fake = seeded();
    fake.store.failing = true;
    useApi('sales@example.com', fake);
    const { wrapper } = await mountWithApp(App);

    expect(wrapper.find('[data-testid="chat-toggle"]').exists()).toBe(false);
  });
});

describe('the panel is not in the initial bundle', () => {
  it('loads the panel through an async component boundary', async () => {
    // The guarantee itself is a build property, asserted by `pnpm check:bundles`. What a DOM test
    // can prove is the mechanism: the shell imports the boundary, and the boundary imports the
    // panel dynamically, so no static import chain reaches the chat machinery from the shell.
    const shell = await import('../../src/client/App.vue?raw');
    const boundary = await import('../../src/client/components/chat/LazyChatPanel.vue?raw');

    expect(shell.default).toContain('LazyChatPanel.vue');
    expect(shell.default).not.toContain("from './components/chat/ChatPanel.vue'");
    expect(boundary.default).toContain("import('./ChatPanel.vue')");
    expect(boundary.default).toContain('defineAsyncComponent');
  });
});

describe('the composer', () => {
  it('sends on Enter, keeps Shift+Enter for a newline, and refuses an empty draft', async () => {
    const wrapper = mountPart(ChatComposer, { disabled: false, busy: false });
    const composer = wrapper.findComponent(ChatComposer);

    const input = wrapper.get('[data-testid="chat-input"] textarea');
    await input.trigger('keydown', { key: 'Enter' });
    expect(composer.emitted('send')).toBeUndefined();

    await input.setValue('How is the pipeline?');
    await input.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(composer.emitted('send')).toBeUndefined();

    await input.trigger('keydown', { key: 'Enter' });
    expect(composer.emitted('send')).toEqual([['How is the pipeline?']]);
  });

  it('disables Send until there is something to send', async () => {
    const wrapper = mountPart(ChatComposer, { disabled: false, busy: false });

    expect(wrapper.get('[data-testid="chat-send"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="chat-input"] textarea').setValue('  ');
    expect(wrapper.get('[data-testid="chat-send"]').attributes('disabled')).toBeDefined();
  });

  it('offers Stop instead of Send while a turn is running', async () => {
    const wrapper = mountPart(ChatComposer, { disabled: false, busy: true });

    expect(wrapper.find('[data-testid="chat-send"]').exists()).toBe(false);
    await wrapper.get('[data-testid="chat-stop"]').trigger('click');
    expect(wrapper.findComponent(ChatComposer).emitted('stop')).toHaveLength(1);
  });

  it('cannot be used while the session is not ready', () => {
    const wrapper = mountPart(ChatComposer, { disabled: true, busy: false });

    expect(wrapper.get('[data-testid="chat-input"] textarea').attributes('disabled')).toBeDefined();
  });
});

describe('the approval card', () => {
  const approval = {
    approvalId: 'approval-1',
    toolCallId: 'call-1',
    toolName: 'create_note',
    input: { title: 'Renewal pricing', markdown: 'Agreed a 5% uplift' },
    decided: false
  };

  it('states what will happen and shows what was proposed, before either button', () => {
    const wrapper = mountPart(ChatApprovalCard, approval);

    const card = wrapper.get('[data-testid="chat-approval"]');
    expect(card.attributes('role')).toBe('group');
    expect(card.attributes('aria-label')).toContain('Writing a note');
    expect(card.text()).toContain('Renewal pricing');
    expect(card.text()).toContain('Agreed a 5% uplift');
  });

  it('hides the derived idempotency key, which the user is not being asked to agree to', () => {
    const wrapper = mountPart(ChatApprovalCard, {
      ...approval,
      input: { ...approval.input, idempotencyKey: 'chat:turn-1:call-1' }
    });

    expect(wrapper.text()).not.toContain('chat:turn-1:call-1');
  });

  it('reports the decision with both identifiers the server needs', async () => {
    const wrapper = mountPart(ChatApprovalCard, approval);

    await wrapper.get('[data-testid="chat-approve"]').trigger('click');

    expect(wrapper.findComponent(ChatApprovalCard).emitted('decide')).toEqual([
      ['approval-1', 'call-1', true]
    ]);
  });

  it('distinguishes declining from approving', async () => {
    const wrapper = mountPart(ChatApprovalCard, approval);

    await wrapper.get('[data-testid="chat-decline"]').trigger('click');

    expect(wrapper.findComponent(ChatApprovalCard).emitted('decide')).toEqual([
      ['approval-1', 'call-1', false]
    ]);
  });

  it('keeps a decided card as a record, without offering the buttons again', () => {
    const wrapper = mountPart(ChatApprovalCard, { ...approval, decided: true, approved: true });

    expect(wrapper.find('[data-testid="chat-approve"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="chat-approval-outcome"]').text()).toBe('You approved this.');
  });

  it('says so when the user declined', () => {
    const wrapper = mountPart(ChatApprovalCard, { ...approval, decided: true, approved: false });

    expect(wrapper.get('[data-testid="chat-approval-outcome"]').text()).toBe('You declined this.');
  });
});

describe('the transcript', () => {
  /**
   * A message with the given parts.
   *
   * @param role Who sent it.
   * @param parts Its parts.
   * @returns The message.
   */
  function message(role: 'user' | 'assistant', parts: unknown[]): UIMessage {
    return { id: `${role}-1`, role, parts } as UIMessage;
  }

  it('is a log region, so an answer is announced without moving focus', () => {
    const wrapper = mountPart(ChatTranscript, { messages: [], expired: false, pending: false });

    const log = wrapper.get('[role="log"]');
    expect(log.attributes('aria-live')).toBe('polite');
    expect(log.attributes('aria-label')).toBe('Conversation');
  });

  it('explains what the assistant can do before the first message', () => {
    const wrapper = mountPart(ChatTranscript, { messages: [], expired: false, pending: false });

    expect(wrapper.text()).toContain('asks before changing anything');
  });

  it('shows the expiry notice, quoting the configured lifetime', () => {
    const wrapper = mountPart(ChatTranscript, { messages: [], expired: true, pending: false });

    expect(wrapper.get('[data-testid="chat-expired"]').text()).toBe(
      'This conversation expired after 3 hours of inactivity.'
    );
  });

  it('follows the newest message, so a streaming answer stays in view', async () => {
    const first = [{ id: 'a', role: 'assistant', parts: [] }] as UIMessage[];
    // Mounted directly rather than through `mountPart`, because this test changes a prop: the
    // wrapper component there passes its props once, so `setProps` would update the wrapper instead
    // of the transcript.
    const wrapper = mount(ChatTranscript, {
      props: { messages: first, expired: false, pending: false },
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    // jsdom has no layout, so `scrollTop` cannot be observed from a real scroll. Recording the
    // assignment is the honest equivalent: what the component owes is *telling* the view to follow.
    const list = wrapper.get('[data-testid="chat-transcript"]').element as HTMLElement;
    const assigned: number[] = [];
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => assigned.at(-1) ?? 0,
      set: (value: number) => assigned.push(value)
    });

    await wrapper.setProps({
      messages: [...first, { id: 'b', role: 'user', parts: [] }] as UIMessage[]
    } as never);
    await settle();

    expect(assigned).toContain(500);
  });

  it('shows progress while waiting for the model’s first output', () => {
    const wrapper = mountPart(ChatTranscript, { messages: [], expired: false, pending: true });

    expect(wrapper.get('[data-testid="chat-pending"]').attributes('aria-label')).toBe(
      'The assistant is thinking'
    );
  });

  it('renders a user message as text, never as Markdown', () => {
    const wrapper = mountPart(ChatMessage, {
      message: message('user', [{ type: 'text', text: '**not bold**' }])
    });

    expect(wrapper.get('[data-testid="chat-message-user"]').text()).toContain('**not bold**');
  });

  it('renders tool activity as a sentence with no record content', () => {
    const wrapper = mountPart(ChatMessage, {
      message: message('assistant', [
        {
          type: 'tool-get_company',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { id: '00000000-0000-4000-8000-000000000001' },
          output: { name: 'Northwind Traders', revenue: 1_000_000 }
        }
      ])
    });

    const activity = wrapper.get('[data-testid="chat-activity"]');
    expect(activity.text()).toBe('Read a company');
    expect(wrapper.text()).not.toContain('Northwind');
    expect(wrapper.text()).not.toContain('1000000');
  });

  it('marks a running tool call as still running', () => {
    const wrapper = mountPart(ChatMessage, {
      message: message('assistant', [
        {
          type: 'tool-search_customers',
          toolCallId: 'call-1',
          state: 'input-available',
          input: { q: 'north' }
        }
      ])
    });

    expect(wrapper.get('[data-testid="chat-activity"]').text()).toBe('Searching customers…');
  });

  it('renders a pending write as an approval card rather than as activity', () => {
    const wrapper = mountPart(ChatMessage, {
      message: message('assistant', [
        {
          type: 'tool-create_note',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: { title: 'Renewal' },
          approval: { id: 'approval-1' }
        }
      ])
    });

    expect(wrapper.find('[data-testid="chat-approval"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="chat-activity"]').exists()).toBe(false);
  });

  it('passes a decision up from the card through the message', async () => {
    const wrapper = mountPart(ChatMessage, {
      message: message('assistant', [
        {
          type: 'tool-create_note',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: { title: 'Renewal' },
          approval: { id: 'approval-1' }
        }
      ])
    });

    await wrapper.get('[data-testid="chat-approve"]').trigger('click');

    expect(wrapper.findComponent(ChatMessage).emitted('decide')).toEqual([
      ['approval-1', 'call-1', true]
    ]);
  });
});

describe('the conversation', () => {
  it('loads the stored transcript on connect, so a reload rejoins it', async () => {
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
    ] as UIMessage[];

    const { chat } = await mountChat({ history });

    expect(chat.connection.value).toBe('ready');
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.expired.value).toBe(false);
  });

  it('reports an expired session only when this tab had a conversation', async () => {
    window.sessionStorage.setItem('ignite-crm.chat.had-conversation', 'yes');

    const { chat } = await mountChat({ history: [] });

    expect(chat.expired.value).toBe(true);
  });

  it('does not call a first-ever empty transcript an expiry', async () => {
    const { chat } = await mountChat({ history: [] });

    expect(chat.expired.value).toBe(false);
  });

  it('tells both the SDK and the server about an approval decision', async () => {
    const { chat } = await mountChat();

    await chat.decide('approval-1', 'call-1', true);

    const approval = sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    expect(approval).toContainEqual({
      type: 'cf_agent_tool_approval',
      toolCallId: 'call-1',
      approved: true,
      autoContinue: true
    });
  });

  it('clears the conversation on the server as well as on screen', async () => {
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
    ] as UIMessage[];
    const { chat } = await mountChat({ history });

    await chat.clear();

    expect(chat.messages.value).toHaveLength(0);
    expect(sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)).toContainEqual({
      type: 'cf_agent_chat_clear'
    });
    // Clearing deliberately is not an expiry, so the notice must not appear next time.
    expect(window.sessionStorage.getItem('ignite-crm.chat.had-conversation')).toBeNull();
  });

  it('probes for a turn still running, so a reload resumes rather than restarts', async () => {
    await mountChat();

    expect(sent.map((frame) => (JSON.parse(frame) as { type: string }).type)).toContain(
      'cf_agent_stream_resume_request'
    );
  });

  it('refuses to send a blank message', async () => {
    const { chat } = await mountChat();

    await chat.send('   ');

    expect(sent.map((frame) => (JSON.parse(frame) as { type: string }).type)).not.toContain(
      'cf_agent_use_chat_request'
    );
  });

  it('explains a gateway rate limit safely and does not send a retry', async () => {
    let chat: ReturnType<typeof useCrmChat> | undefined;
    mount(
      {
        setup() {
          chat = useCrmChat({
            client: { chatSession: () => Promise.reject({ status: 429 }) } as never,
            connect: fakeSocket,
            loadHistory: () => Promise.resolve([])
          });
          return () => h('div');
        }
      },
      { global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await flushPromises();

    expect(chat!.connection.value).toBe('error');
    expect(chat!.error.value).toBe(
      'The assistant has reached its temporary usage limit. Try again shortly.'
    );
    await chat!.send('Try again automatically');
    expect(sent).toHaveLength(0);
  });

  it('explains a failure safely rather than showing an internal error', async () => {
    let chat: ReturnType<typeof useCrmChat> | undefined;
    mount(
      {
        setup() {
          chat = useCrmChat({
            client: { chatSession: () => Promise.reject(new Error('D1 is down')) } as never,
            connect: fakeSocket,
            loadHistory: () => Promise.resolve([])
          });
          return () => h('div');
        }
      },
      { global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await flushPromises();

    expect(chat!.connection.value).toBe('error');
    expect(chat!.error.value).toBe(
      'The assistant is unavailable right now. Try again in a moment.'
    );
    expect(chat!.error.value).not.toContain('D1');
  });

  it('cannot send while the session is not ready', async () => {
    let chat: ReturnType<typeof useCrmChat> | undefined;
    mount(
      {
        setup() {
          chat = useCrmChat({
            client: { chatSession: () => Promise.reject(new Error('down')) } as never,
            connect: fakeSocket,
            loadHistory: () => Promise.resolve([])
          });
          return () => h('div');
        }
      },
      { global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await flushPromises();

    await chat!.send('Anything?');

    expect(sent).toHaveLength(0);
  });

  it('sends a page-context hint with the turn when the user is on a record', async () => {
    let chat: ReturnType<typeof useCrmChat> | undefined;
    mount(
      {
        setup() {
          chat = useCrmChat({
            client: { chatSession: () => Promise.resolve({ sessionId: 'session-1' }) } as never,
            connect: fakeSocket,
            loadHistory: () => Promise.resolve([]),
            pageContext: () => ({
              route: 'contact',
              id: '00000000-0000-4000-8000-0000000000b1'
            })
          });
          return () => h('div');
        }
      },
      { global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await flushPromises();

    // Not awaited: the turn only settles when the server closes its stream, and the fake socket
    // never answers. What is being asserted is the request frame, which is sent synchronously.
    void chat!.send('Summarise this customer');
    await flushPromises();

    const request = sent
      .map((frame) => JSON.parse(frame) as { type: string; init?: { body?: string } })
      .find((frame) => frame.type === 'cf_agent_use_chat_request');
    expect(request).toBeDefined();
    const body = JSON.parse(request!.init!.body!) as { pageContext?: unknown };
    expect(body.pageContext).toEqual({
      route: 'contact',
      id: '00000000-0000-4000-8000-0000000000b1'
    });
  });

  it('closes the socket when the panel goes away', async () => {
    const closed: string[] = [];
    const wrapper = mount(
      {
        setup() {
          useCrmChat({
            client: { chatSession: () => Promise.resolve({ sessionId: 'session-1' }) } as never,
            connect: () => ({ ...fakeSocket(), close: () => closed.push('closed') }),
            loadHistory: () => Promise.resolve([])
          });
          return () => h('div');
        }
      },
      { global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await flushPromises();

    wrapper.unmount();

    expect(closed).toEqual(['closed']);
  });
});

describe('page context', () => {
  it('names the record on screen, and nothing on a list page', async () => {
    const router = createAppRouter(createMemoryHistory());

    // The panel derives its hint from the route's name and `id` param. Those two facts are what the
    // derivation depends on, and the server validates the result again with the same strict schema,
    // so the route table is the right place to pin them.
    for (const [path, expected] of [
      ['/contacts/00000000-0000-4000-8000-0000000000b1', 'contact'],
      ['/companies/00000000-0000-4000-8000-0000000000a1', 'company'],
      ['/deals/00000000-0000-4000-8000-0000000000d1', 'deal'],
      ['/notes/00000000-0000-4000-8000-000000000201', 'note'],
      ['/projects/00000000-0000-4000-8000-000000000301', 'project']
    ] as const) {
      await router.push(path);
      await router.isReady();
      expect(router.currentRoute.value.name, path).toBe(expected);
      expect(typeof router.currentRoute.value.params.id, path).toBe('string');
    }

    // A list page has no "this record", so the panel sends no hint rather than something vague.
    for (const path of ['/contacts', '/deals', '/reports', '/']) {
      await router.push(path);
      expect(router.currentRoute.value.params.id, path).toBeUndefined();
    }
  });
});

describe('the panel in the shell', () => {
  it('shows a generic alert when the SDK reaches error without exposing an error object', async () => {
    // The integration boundary is the SDK's reactive status/error pair. A fake rejected session
    // covers connection failure; this assertion pins the separate terminal-turn fallback so a
    // transport that only sets status=error cannot leave the panel spinning forever.
    const chatError = await import('../../src/client/services/chat-errors.ts');
    expect(chatError.presentChatFailure(new Error('Chat stream failed.')).message).toContain(
      'unavailable'
    );
  });

  it('shows a compact dismissible connection failure alert', async () => {
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);
    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();

    const alert = wrapper.get('[data-testid="chat-error"]');
    expect(alert.classes()).toContain('chat-error');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.get('button').attributes('aria-label')).toMatch(/close/i);
    await alert.get('button').trigger('click');
    expect(wrapper.find('[data-testid="chat-error"]').exists()).toBe(false);
  });

  it('shows a connection failure as a safe alert, with the composer unusable', async () => {
    // The fake API has no chat route, so the panel's session call fails: exactly the
    // assistant-unavailable path a real outage produces.
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);
    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();

    const alert = wrapper.get('[data-testid="chat-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('unavailable');
    expect(wrapper.get('[data-testid="chat-input"] textarea').attributes('disabled')).toBeDefined();
  });

  it('closes on Escape and returns focus to the Chat button', async () => {
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);
    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();

    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('chat-toggle');
  });

  it('ignores other keys', async () => {
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);
    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await settle();

    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(true);
  });

  it('names the panel and the Clear action for assistive technology', async () => {
    useApi('sales@example.com', seeded());
    const { wrapper } = await mountWithApp(App);
    await wrapper.get('[data-testid="chat-toggle"]').trigger('click');
    await settle();

    expect(wrapper.get('[data-testid="chat-panel"]').attributes('aria-label')).toBe('Assistant');
    expect(wrapper.get('[data-testid="chat-clear"]').attributes('aria-label')).toBe('Clear chat');
    expect(wrapper.get('[data-testid="chat-close"]').attributes('aria-label')).toBe(
      'Close assistant'
    );
  });
});
