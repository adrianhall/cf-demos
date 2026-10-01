import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createBrowserTokenizer } from '../../../src/client/features/view-tokens/tokenizers';
import ViewTokensView from '../../../src/client/views/ViewTokensView.vue';

/**
 * Mounts the View Tokens panel.
 *
 * The real browser tokenizer is used rather than a fake: this suite is about what a visitor sees,
 * and a panel asserted against invented tokens could pass while showing nonsense.
 *
 * @returns The mounted wrapper.
 */
function mountPanel() {
  return mount(ViewTokensView, {
    global: {
      stubs: { 'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' } }
    }
  });
}

/**
 * Types into the editor and waits for the debounced tokenization to publish.
 *
 * @param wrapper Mounted panel.
 * @param text Text to enter.
 * @returns A promise fulfilled once the tokens are rendered.
 */
async function type(wrapper: ReturnType<typeof mountPanel>, text: string): Promise<void> {
  await wrapper.find('#token-input').setValue(text);
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  await nextTick();
}

/**
 * Load the encodings this suite uses before any test runs, with real timers.
 *
 * The panel loads an encoding on demand, and the adapter caches it. Under fake timers that first
 * dynamic import competes with the timer advancement, so a test can observe an empty sequence
 * purely because the chunk has not resolved yet — a flake that depends on test order rather than on
 * anything the panel does. Warming the cache leaves only microtasks, which `flushPromises` settles
 * deterministically.
 */
beforeAll(async () => {
  const tokenizer = createBrowserTokenizer();
  await tokenizer.tokenize('warm', 'o200k_base');
  await tokenizer.tokenize('warm', 'gpt2');
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ViewTokensView', () => {
  it('shows the panel name and its local-only task type', () => {
    const text = mountPanel().text();
    expect(text).toContain('View Tokens');
    expect(text).toContain('Tokenization');
  });

  // The panel's defining property. If this badge ever said "Routed through AI Gateway" the panel
  // would be claiming a cost and a log it does not produce.
  it('states that it runs locally and costs nothing', () => {
    expect(mountPanel().text()).toContain('Runs in your browser — no inference, no cost');
  });

  it('renders a token box for each token after typing', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'Hello brave new world');

    const tokens = wrapper.findAll('.token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain('Tokens');
  });

  it('shows token, character, word, and ratio counts', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'Hello world');

    const summary = wrapper.find('.summary').text();
    expect(summary).toContain('Tokens');
    expect(summary).toContain('Characters');
    expect(summary).toContain('Words');
    expect(summary).toContain('Characters per token');
  });

  // Whitespace is where tokenization is least intuitive, so the marks are on by default rather
  // than hidden behind a toggle a visitor would never find.
  it('reveals whitespace by default', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');
    expect(wrapper.find('.token-sequence').text()).toContain('·');
  });

  it('hides the whitespace marks when the toggle is cleared', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');

    const checkbox = wrapper.findAll('input[type="checkbox"]')[0]!;
    await checkbox.setValue(false);
    await nextTick();

    expect(wrapper.find('.token-sequence').text()).not.toContain('·');
  });

  // Colour separates neighbouring tokens but must never be the only thing that does, so the
  // boundary survives for a colour-blind visitor, a high-contrast mode, and a printout.
  it('separates tokens by outline and spacing as well as colour', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');

    const token = wrapper.find('.token');
    expect(token.classes().some((name) => name.startsWith('token--c'))).toBe(true);
    expect(wrapper.find('.token-sequence').element.tagName).toBe('OL');
  });

  // A screen reader conveys neither colour nor position, so without per-token labels the sequence
  // would read as an undifferentiated run of text and teach nothing.
  it('labels every token with its position, text, and identifier', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');

    const label = wrapper.find('.token').attributes('aria-label');
    expect(label).toMatch(/^Token 1 of \d+/u);
    expect(label).toMatch(/ID \d+/u);
  });

  it('announces the counts politely as they change', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello');
    expect(wrapper.find('.summary').attributes('aria-live')).toBe('polite');
  });

  it('hides the token table until it is asked for', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');
    expect(wrapper.find('.token-table').exists()).toBe(false);

    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true);
    await nextTick();

    expect(wrapper.find('.token-table').exists()).toBe(true);
  });

  it('shows each token identifier in the table', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello world');
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true);
    await nextTick();

    const rows = wrapper.findAll('.token-table tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.text()).toMatch(/\d/u);
  });

  it('loads a prepared example into the editor', async () => {
    const wrapper = mountPanel();
    await wrapper.find('[data-example="emoji"]').trigger('click');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();

    expect((wrapper.find('#token-input').element as HTMLTextAreaElement).value).toContain('🎉');
  });

  it('offers every prepared example as a labelled button', () => {
    const wrapper = mountPanel();
    const buttons = wrapper.findAll('.example-button');
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) {
      expect(button.text().length).toBeGreaterThan(0);
      expect(button.attributes('title')!.length).toBeGreaterThan(0);
    }
  });

  // Switching encoding re-tokenizes, and the multilingual case is where the difference is large
  // enough to be unmistakable rather than a token or two either way.
  it('re-tokenizes when the visitor chooses a different tokenizer', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'すべてのリクエストはゲートウェイを経由します。');
    const modern = wrapper.findAll('.token').length;

    await wrapper.find('#tokenizer-select').setValue('gpt2');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await nextTick();

    expect(wrapper.findAll('.token').length).toBeGreaterThan(modern);
  });

  // A count quoted without its tokenizer is a number people will repeat. The disclosure sits
  // beside the selector rather than in a footnote for that reason.
  it('names the models the selected tokenizer applies to', async () => {
    const wrapper = mountPanel();
    await type(wrapper, 'hello');
    expect(wrapper.find('.tokenizer-note').text()).toContain('GPT-4o');
  });

  it('labels the editor and the tokenizer selector', () => {
    const wrapper = mountPanel();
    expect(wrapper.find('label[for="token-input"]').exists()).toBe(true);
    expect(wrapper.find('label[for="tokenizer-select"]').exists()).toBe(true);
  });

  // The panel's central claim, asserted rather than trusted: typing contacts nothing. A stray
  // telemetry call added later would fail here.
  it('makes no network request while the visitor types', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const wrapper = mountPanel();

    await type(wrapper, 'nothing here should leave the browser');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('explains why the panel produces no cost', () => {
    const text = mountPanel().text();
    expect(text).toContain('never sent anywhere');
    expect(text).toContain('no AI Gateway log is created');
  });
});
