import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PanelNavigation from '../../../src/client/components/shell/PanelNavigation.vue';
import { TASK_DESCRIPTORS } from '../../../src/shared/tasks';

/**
 * Mount the sidebar navigation with router links stubbed to anchors.
 *
 * The stub renders `router-link` as a real `<a>` carrying its `to` as `href`, so the assertions
 * inspect the destinations a visitor would actually follow rather than component internals.
 *
 * @returns The mounted wrapper.
 */
function mountNavigation() {
  return mount(PanelNavigation, {
    global: {
      stubs: {
        'router-link': {
          props: ['to'],
          template: '<a :href="to"><slot /></a>'
        }
      }
    }
  });
}

describe('PanelNavigation', () => {
  it('renders a link for every panel', () => {
    const links = mountNavigation().findAll('a.panel-link');
    expect(links).toHaveLength(TASK_DESCRIPTORS.length);
  });

  // Every panel is one click from anywhere. A panel reachable only after opening something else
  // would be the nested navigation this product deliberately does not have.
  it('links every panel at the top level, using its identifier as the path', () => {
    const wrapper = mountNavigation();
    for (const task of TASK_DESCRIPTORS) {
      const link = wrapper.find(`a[data-task="${task.id}"]`);
      expect(link.exists(), `${task.name} should have a link`).toBe(true);
      expect(link.attributes('href')).toBe(`/${task.id}`);
    }
  });

  it('shows every panel by its action name', () => {
    const text = mountNavigation().text();
    for (const task of TASK_DESCRIPTORS) {
      expect(text).toContain(task.name);
    }
  });

  // Group labels are decoration. The moment one becomes a button or a disclosure, the navigation
  // is two levels deep and a visitor has to find a panel before they can click it.
  it('renders group labels as headings, not controls', () => {
    const wrapper = mountNavigation();
    const headings = wrapper.findAll('h2.group-heading');
    expect(headings.length).toBeGreaterThan(0);

    for (const heading of headings) {
      expect(heading.element.tagName).toBe('H2');
      expect(heading.attributes('role')).toBeUndefined();
      expect(heading.attributes('tabindex')).toBeUndefined();
      expect(heading.find('button').exists()).toBe(false);
      expect(heading.find('a').exists()).toBe(false);
    }
  });

  it('has no phase label when every listed panel is delivered', () => {
    expect(TASK_DESCRIPTORS.some((task) => task.availability === 'planned')).toBe(false);
  });

  // A delivered panel carries no phase label. Leaving one behind would make the sidebar read as if
  // the panel were still pending while it was in fact usable.
  it('does not label a delivered panel with a phase', () => {
    const wrapper = mountNavigation();
    expect(wrapper.find('a[data-task="chat"]').text()).not.toContain('Phase');
  });

  // The badge marks what is still to come. Once a panel is delivered its badge disappears, so the
  // sidebar reads as a progress indicator rather than a permanent list of phase numbers.
  it('badges exactly the panels that are not built yet', () => {
    const wrapper = mountNavigation();
    for (const task of TASK_DESCRIPTORS) {
      const badged = wrapper.find(`a[data-task="${task.id}"]`).find('.panel-badge').exists();
      expect(badged, `${task.name} badge`).toBe(task.availability === 'planned');
    }
  });

  // A screen-reader user navigating by landmark needs the panel list to be one, so they can skip
  // fifteen links rather than tab through them to reach the content.
  it('exposes the panel list as a named navigation landmark', () => {
    const nav = mountNavigation().find('nav');
    expect(nav.exists()).toBe(true);
    expect(nav.attributes('aria-label')).toBe('Playground panels');
  });

  it('groups panels under their declared group label', () => {
    const wrapper = mountNavigation();
    const headings = wrapper.findAll('h2.group-heading').map((heading) => heading.text());
    const expected = [...new Set(TASK_DESCRIPTORS.map((task) => task.group))];
    expect(headings).toEqual(expected);
  });
});
