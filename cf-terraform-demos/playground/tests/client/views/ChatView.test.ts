import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { CHAT_EXAMPLES } from '../../../src/client/features/chat/examples';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import ChatView from '../../../src/client/views/ChatView.vue';
import { clickTeleported, openDialogText, panelText } from '../support/panel';

/**
 * Reviewed models as the catalogue endpoint reports them.
 */
const MODELS = [
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name: 'Llama 3.3 70B (fast)',
    provider: 'workers-ai',
    task: 'chat' as const,
    pricingUnit: 'token',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/x/',
    contextWindowTokens: 24_000
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B',
    provider: 'workers-ai',
    task: 'chat' as const,
    pricingUnit: 'token',
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/y/',
    contextWindowTokens: 80_000
  }
];

/**
 * Mounts the Chat view with a pre-populated catalogue.
 *
 * @returns The mounted wrapper.
 */
async function mountChat() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.models = MODELS;
  catalogue.loaded = true;

  const wrapper = mount(ChatView, {
    global: {
      plugins: [pinia],
      stubs: {
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' },
        'v-btn': { template: '<button><slot /></button>' }
      }
    }
  });

  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  // The view fetches the catalogue on mount. The store is pre-populated, so this only guards
  // against a real network call if that changes.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ models: MODELS }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatView', () => {
  // The name is teleported into the shell's header bar and the task type now lives in the
  // description modal, so each is read from where it actually renders.
  it('shows the panel name in the header', async () => {
    expect(panelText(await mountChat())).toContain('Chat');
  });

  it('describes its technical task type in the panel description', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Text generation');
  });

  it('declares that the panel is routed through AI Gateway', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Routed through AI Gateway');
  });

  // The visitor is told their email is recorded in gateway metadata *before* they send anything,
  // not in a footnote afterwards. This is the disclosure the whole attribution design depends on.
  it('discloses email attribution before the first request', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/verified email is recorded in the AI Gateway log/iu);
  });

  it('warns that the panel spends real inference credit', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/real inference credit/iu);
  });

  // Tells the visitor to assume their prompt is logged, rather than promising it is not. Payload
  // retention is AI Gateway's behaviour, the AI binding exposes no payload-collection option, and
  // the gateway documents that a log can include the prompt — so a reassurance here would be a
  // claim this application cannot keep on a visitor's behalf.
  it('warns that the prompt should be assumed logged', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your prompt and the answer are logged/iu);
    expect(text).toMatch(/nothing confidential|anything confidential/iu);
  });

  it('makes no promise that the prompt or answer is unretained', async () => {
    const text = (await mountChat()).text();
    expect(text).not.toMatch(/not stored/iu);
    expect(text).not.toMatch(/not retained/iu);
    expect(text).not.toMatch(/never stored/iu);
  });

  it('offers every reviewed model from the catalogue', async () => {
    const options = (await mountChat()).findAll('#model-select option');
    expect(options.map((option) => option.text())).toEqual([
      'Llama 3.3 70B (fast)',
      'Llama 3.2 3B'
    ]);
  });

  // The catalogue's order is the preference order, so there is no second list to keep in step.
  it('selects the first reviewed model by default', async () => {
    const select = (await mountChat()).find<HTMLSelectElement>('#model-select');
    expect(select.element.value).toBe(MODELS[0]!.id);
  });

  it('labels the message field', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('label[for="chat-input"]').exists()).toBe(true);
    expect(wrapper.find('#chat-input').exists()).toBe(true);
  });

  it('disables Send while the draft is empty', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('.send-button').attributes('disabled')).toBeDefined();
  });

  it('enables Send once something is typed', async () => {
    const wrapper = await mountChat();
    await wrapper.find('#chat-input').setValue('Hello');
    expect(wrapper.find('.send-button').attributes('disabled')).toBeUndefined();
  });

  it('shows no Cancel button while nothing is streaming', async () => {
    expect((await mountChat()).find('.cancel-button').exists()).toBe(false);
  });

  it('offers every prepared example', async () => {
    const wrapper = await mountChat();
    for (const example of CHAT_EXAMPLES) {
      expect(
        wrapper.find(`[data-example="${example.id}"]`).exists(),
        `${example.label} button`
      ).toBe(true);
    }
  });

  // A prepared prompt that spent money the moment it was clicked would be a trap in a panel that
  // bills per request, so loading an example fills the editor rather than sending it.
  it('loads an example into the editor without sending it', async () => {
    const wrapper = await mountChat();
    await wrapper.find(`[data-example="${CHAT_EXAMPLES[0]!.id}"]`).trigger('click');

    const input = wrapper.find<HTMLTextAreaElement>('#chat-input');
    expect(input.element.value).toBe(CHAT_EXAMPLES[0]!.prompt);
    expect(wrapper.findAll('li')).toHaveLength(0);
  });

  it('explains what each example demonstrates', async () => {
    const wrapper = await mountChat();
    const button = wrapper.find(`[data-example="${CHAT_EXAMPLES[0]!.id}"]`);
    expect(button.attributes('title')).toBe(CHAT_EXAMPLES[0]!.teaches);
  });

  it('shows a live character count against the limit', async () => {
    const wrapper = await mountChat();
    await wrapper.find('#chat-input').setValue('12345');

    const counter = wrapper.find('.counter');
    expect(counter.text()).toContain('5');
    expect(counter.attributes('aria-live')).toBe('polite');
  });

  // Sampling controls are collapsed by default: temperature means something to a visitor who
  // already knows what it does, and putting it in front of everyone else is noise.
  it('hides the sampling options until they are asked for', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('#temperature-input').exists()).toBe(false);
  });

  it('reveals the sampling options on request', async () => {
    const wrapper = await mountChat();
    const toggle = wrapper.findAll('input[type="checkbox"]')[0]!;
    await toggle.setValue(true);

    expect(wrapper.find('#temperature-input').exists()).toBe(true);
  });

  it('explains that temperature does not improve accuracy', async () => {
    const wrapper = await mountChat();
    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true);
    expect(wrapper.text()).toMatch(/does not make an answer more accurate/iu);
  });

  // The handoff the implementation plan asks for: Chat bills by the token, and View Tokens is where
  // a visitor can see what that means for their own text at no cost.
  it('links to View Tokens so the visitor can see what is billed', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('a[href="/view-tokens"]').exists()).toBe(true);
  });

  it('states the selected model\u2019s context window', async () => {
    expect((await mountChat()).text()).toContain('24,000-token context window');
  });

  it('links the selected model to its catalog page', async () => {
    const wrapper = await mountChat();
    const link = wrapper.find(`a[href="${MODELS[0]!.documentationUrl}"]`);
    expect(link.exists()).toBe(true);
  });

  it('shows no run details before the first run', async () => {
    expect((await mountChat()).find('.run-details').exists()).toBe(false);
  });

  it('shows no error before anything is sent', async () => {
    expect((await mountChat()).find('[role="alert"]').exists()).toBe(false);
  });
});
