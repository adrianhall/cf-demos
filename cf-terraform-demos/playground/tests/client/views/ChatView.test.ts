import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { CHAT_EXAMPLES } from '../../../src/client/features/chat/examples';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import ChatView from '../../../src/client/views/ChatView.vue';
import {
  clickTeleported,
  isDialogOpen,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

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
 * Mounts Chat with a pre-populated catalogue.
 *
 * @returns The mounted wrapper.
 */
async function mountChat() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.models = MODELS;
  catalogue.loaded = true;

  const wrapper = mount(ChatView, {
    attachTo: document.body,
    global: { plugins: [pinia], stubs: panelStubs() }
  });

  await flushPromises();
  return wrapper;
}

/**
 * Builds the SSE response for one successful run.
 *
 * @param markdown Model answer to stream.
 * @returns A response shaped like the real Chat endpoint.
 */
function chatResponse(markdown = 'A **useful** answer.'): Response {
  const receipt = {
    runId: 'run-chat-1',
    task: 'chat',
    model: MODELS[0]!.id,
    gatewayRouted: true,
    logIds: [],
    status: 'completed',
    costStatus: 'unavailable',
    elapsedMs: 340,
    startedAt: '2026-10-02T09:00:00.000Z'
  };
  const frames = [
    { type: 'start', runId: receipt.runId, model: receipt.model },
    { type: 'delta', text: markdown },
    { type: 'completed', receipt }
  ];

  return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

/**
 * Sends one message through the real view/composable wiring.
 *
 * @param wrapper Mounted Chat view.
 * @param answer Model answer to stream.
 * @returns A promise fulfilled once the response and run tracking settle.
 */
async function sendOnce(
  wrapper: Awaited<ReturnType<typeof mountChat>>,
  answer = 'A **useful** answer.'
): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(chatResponse(answer)))
  );
  await wrapper.find('#chat-input').setValue('What is AI Gateway?');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Chat should not reach the network before a test sends a message.');
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel description', () => {
  it('shows the panel name in the header', async () => {
    expect(panelText(await mountChat())).toContain('Chat');
  });

  it('describes the task and gateway route in the About modal', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Text generation');
    expect(openDialogText()).toContain('Routed through AI Gateway');
  });

  it('keeps the credit and logging disclosure before the first request', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/verified email is recorded/iu);
    expect(text).toMatch(/assume your prompt and the answer are logged/iu);
    expect(text).toMatch(/nothing confidential|anything confidential/iu);
  });

  // Reference material moved out of the main flow with the other panel description, leaving the
  // activity itself above the fold.
  it('keeps token and model references in the About modal', async () => {
    await mountChat();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toContain('View Tokens');
    expect(text).toContain('24,000-token context window');
    expect(document.body.querySelector(`a[href="${MODELS[0]!.documentationUrl}"]`)).not.toBeNull();
  });
});

describe('first-run welcome state', () => {
  it('starts with one centred question box and no transcript', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('.welcome-layout').exists()).toBe(true);
    expect(wrapper.find('.transcript').exists()).toBe(false);
    expect(wrapper.findAll('#chat-input')).toHaveLength(1);
  });

  it('asks what the visitor wants to explore', async () => {
    expect((await mountChat()).text()).toContain('What can I help you explore?');
  });

  it('offers every prepared quick question', async () => {
    const wrapper = await mountChat();
    for (const example of CHAT_EXAMPLES) {
      expect(wrapper.find(`[data-example="${example.id}"]`).exists()).toBe(true);
    }
  });

  // Drives the native dropdown through the complete view/composable/component v-model loop. The
  // copyable reference has to identify the *active* option, not merely the model selected at mount.
  it('updates the full model ID when the dropdown selection changes', async () => {
    const wrapper = await mountChat();

    expect(wrapper.find('[data-model-id]').text()).toBe(MODELS[0]!.id);
    await wrapper.find('#model-select').setValue(MODELS[1]!.id);

    expect(wrapper.find('[data-model-id]').text()).toBe(MODELS[1]!.id);
    expect(wrapper.text()).not.toContain(MODELS[0]!.id);
  });

  it('loads a quick question without sending it', async () => {
    const wrapper = await mountChat();
    await wrapper.find(`[data-example="${CHAT_EXAMPLES[0]!.id}"]`).trigger('click');

    expect(wrapper.find<HTMLTextAreaElement>('#chat-input').element.value).toBe(
      CHAT_EXAMPLES[0]!.prompt
    );
    expect(wrapper.find('.transcript').exists()).toBe(false);
  });

  it('puts the model selector inside the question box', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('.composer').find('#model-select').exists()).toBe(true);
    expect(wrapper.findAll('#model-select option').map((option) => option.text())).toEqual([
      MODELS[0]!.name,
      MODELS[1]!.name
    ]);
  });

  it('selects the first reviewed model by default', async () => {
    const select = (await mountChat()).find<HTMLSelectElement>('#model-select');
    expect(select.element.value).toBe(MODELS[0]!.id);
  });

  it('disables Send until a message is entered', async () => {
    const wrapper = await mountChat();
    const send = wrapper.find('[aria-label="Send message"]');
    expect(send.attributes('disabled')).toBeDefined();

    await wrapper.find('#chat-input').setValue('Hello');
    expect(send.attributes('disabled')).toBeUndefined();
  });

  it('reveals sampling inside the composer on request', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('#temperature-input').isVisible()).toBe(false);

    await wrapper.find('[aria-controls="sampling-options"]').trigger('click');
    expect(wrapper.find('#temperature-input').isVisible()).toBe(true);
    expect(wrapper.text()).toMatch(/do not improve accuracy/iu);
  });
});

describe('conversation flow', () => {
  it('switches from welcome to transcript after the first message', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);

    expect(wrapper.find('.welcome-layout').exists()).toBe(false);
    expect(wrapper.find('.conversation-layout').exists()).toBe(true);
    expect(wrapper.find('.transcript').exists()).toBe(true);
  });

  // Sending replaces the entire welcome composer with the docked conversation composer. The new
  // editor must take focus or a keyboard user is dropped at the top of the document.
  it('moves focus into the docked composer after the first message', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);

    expect(document.activeElement).toBe(wrapper.find('#chat-input').element);
  });

  it('shows the user message and assistant answer in order', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);

    const turns = wrapper.findAll('.turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]?.text()).toContain('What is AI Gateway?');
    expect(turns[1]?.text()).toContain('A useful answer.');
  });

  it('renders assistant Markdown in the conversation', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper, 'Use **AI Gateway** and:\n\n- log requests\n- measure cost');

    expect(wrapper.find('.turn--assistant strong').text()).toBe('AI Gateway');
    expect(wrapper.findAll('.turn--assistant li')).toHaveLength(2);
  });

  it('places the transcript before the bottom composer in document order', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);

    const transcript = wrapper.find('.transcript').element;
    const dock = wrapper.find('.composer-dock').element;
    expect(
      transcript.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the model selector in the conversation composer', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);
    expect(wrapper.find('.composer-dock #model-select').exists()).toBe(true);
  });

  it('offers New chat after a response completes', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);
    expect(wrapper.find('.new-chat-button').exists()).toBe(true);
  });

  it('returns to the welcome state for a new conversation', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);
    const button = wrapper.find('.new-chat-button');
    (button.element as HTMLElement).focus();
    await button.trigger('click');

    expect(wrapper.find('.welcome-layout').exists()).toBe(true);
    expect(wrapper.find('.transcript').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('#chat-input').element);
  });
});

describe('run details', () => {
  it('keeps the activator inside the composer', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);

    expect(wrapper.find('.composer-dock .run-details-button').exists()).toBe(true);
  });

  it('keeps details closed until asked for', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);
    expect(isDialogOpen()).toBe(false);
  });

  it('opens the same Run details modal used by the media panels', async () => {
    const wrapper = await mountChat();
    await sendOnce(wrapper);
    await wrapper.find('.run-details-button').trigger('click');

    expect(openDialogText()).toContain('Run details');
    expect(openDialogText()).toContain(MODELS[0]!.id);
    // Embedded: the modal title is the only title, with no duplicate inner card heading.
    expect(document.body.querySelector('.run-details-heading')).toBeNull();
  });
});
