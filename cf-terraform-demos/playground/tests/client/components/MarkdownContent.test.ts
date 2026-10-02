import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownContent from '../../../src/client/features/chat/MarkdownContent.vue';

/**
 * Mounts rendered Markdown.
 *
 * @param source Markdown source to render.
 * @returns The mounted wrapper.
 */
function render(source: string) {
  return mount(MarkdownContent, { props: { source } });
}

describe('MarkdownContent', () => {
  it('renders paragraphs and emphasis', () => {
    const wrapper = render('A **bold** answer with *emphasis*.');
    expect(wrapper.find('strong').text()).toBe('bold');
    expect(wrapper.find('em').text()).toBe('emphasis');
  });

  it('renders headings and lists below the page heading level', () => {
    const wrapper = render('## Steps\n\n1. First\n2. Second');
    expect(wrapper.find('h4').text()).toBe('Steps');
    expect(wrapper.find('h1').exists()).toBe(false);
    expect(wrapper.findAll('ol > li')).toHaveLength(2);
  });

  it('renders fenced code blocks', () => {
    const wrapper = render('```ts\nconst answer = 42;\n```');
    expect(wrapper.find('pre code').text()).toContain('const answer = 42;');
  });

  it('renders GitHub-flavoured tables without stripping table semantics', () => {
    const wrapper = render('| Name | Value |\n| --- | --- |\n| Cost | Low |');
    expect(wrapper.find('table').exists()).toBe(true);
    expect(wrapper.findAll('th')).toHaveLength(2);
    expect(wrapper.find('.markdown').attributes('tabindex')).toBe('0');
  });

  it('turns newlines into breaks for conversational output', () => {
    const wrapper = render('line one\nline two');
    expect(wrapper.find('br').exists()).toBe(true);
  });
});

describe('sanitizing model output', () => {
  // A Markdown parser is not a sanitizer. Raw HTML is legal Markdown, and model output is
  // untrusted even when nobody explicitly asked it to emit markup.
  it('removes script elements', () => {
    const wrapper = render('<script>globalThis.pwned = true</script>Safe text');
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('Safe text');
  });

  it('removes image elements rather than fetching model-chosen URLs', () => {
    const wrapper = render('<img src="https://tracker.example/pixel" onerror="alert(1)">');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('removes unsafe JavaScript links', () => {
    const wrapper = render('[open this](javascript:alert(1))');
    const link = wrapper.find('a');
    // Depending on parser/sanitizer cooperation the anchor may remain without href or be emitted
    // as text. Either outcome is safe; an executable href is not.
    expect(link.attributes('href') ?? '').not.toMatch(/^javascript:/iu);
  });

  it('does not preserve embedded iframes', () => {
    expect(render('<iframe src="https://example.com"></iframe>').find('iframe').exists()).toBe(
      false
    );
  });

  it('removes media elements that could fetch model-chosen URLs', () => {
    const wrapper = render(
      '<video poster="https://tracker.example/pixel"><source src="https://tracker.example/x"></video>'
    );
    expect(wrapper.find('video').exists()).toBe(false);
    expect(wrapper.find('source').exists()).toBe(false);
  });

  it('removes interactive forms from model output', () => {
    const wrapper = render(
      '<form action="https://phish.example"><label>Password<input type="password"></label><button>Submit</button></form>'
    );
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('label').exists()).toBe(false);
  });
});

describe('reactive streaming updates', () => {
  it('re-renders as more Markdown arrives', async () => {
    const wrapper = render('**partial');
    await wrapper.setProps({ source: '**complete**' });

    expect(wrapper.find('strong').text()).toBe('complete');
  });
});
