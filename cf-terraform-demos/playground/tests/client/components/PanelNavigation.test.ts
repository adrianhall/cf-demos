import { beforeEach, describe, expect, it } from 'vitest';
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
  // The collapsed set is persisted, so without this one test's collapsing would leak into the
  // next and the "expanded by default" assertions would pass or fail depending on file order.
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

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

  // Replaces the former `renders group labels as headings, not controls`. Groups are now
  // disclosures, which is a deliberate reversal — but the heading has to survive the change. A
  // `button` that *replaced* the `h2` would take the panel list out of heading navigation, so the
  // contract pinned here is "a heading that contains a toggle", not "a toggle".
  it('renders each group label as a heading containing its disclosure toggle', () => {
    const wrapper = mountNavigation();
    const headings = wrapper.findAll('h2.group-heading');
    expect(headings.length).toBeGreaterThan(0);

    for (const heading of headings) {
      expect(heading.element.tagName).toBe('H2');
      expect(heading.attributes('role')).toBeUndefined();

      const toggle = heading.find('button.group-toggle');
      expect(toggle.exists(), 'group heading should contain a toggle button').toBe(true);
      // An explicit type, because a `button` inside a form defaults to submitting one.
      expect(toggle.attributes('type')).toBe('button');
      expect(heading.find('a').exists()).toBe(false);
    }
  });

  // `aria-controls` has to name the list the button governs, and that list has to exist. A toggle
  // pointing at a missing id tells assistive technology there is a relationship and then fails to
  // deliver it, which is worse than claiming none at all.
  it('points every toggle at the panel list it governs', () => {
    const wrapper = mountNavigation();

    for (const toggle of wrapper.findAll('button.group-toggle')) {
      const controls = toggle.attributes('aria-controls');
      expect(controls, 'toggle should declare aria-controls').toBeTruthy();
      expect(wrapper.find(`ul#${controls}`).exists(), `${controls} should exist`).toBe(true);
    }
  });

  it('expands every group by default', () => {
    const wrapper = mountNavigation();
    for (const toggle of wrapper.findAll('button.group-toggle')) {
      expect(toggle.attributes('aria-expanded')).toBe('true');
    }
  });

  // `aria-expanded` is the only thing that tells a screen-reader user what the button just did, so
  // it has to track the visible state rather than being set once at mount.
  it('tracks the open state of a group in aria-expanded', async () => {
    const wrapper = mountNavigation();
    const toggle = wrapper.find('button[data-group="Generate"]');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
  });

  // Collapsing hides the links visually, but the markup stays put: `v-show` rather than `v-if`
  // keeps the `aria-controls` target real and keeps the panel findable by in-page search.
  //
  // Visibility is read only once per mount: Vue Test Utils memoizes `isVisible()` per wrapper
  // tree, so checking the expanded state first here would report the stale answer afterwards. The
  // expanded default is asserted by its own test above.
  it('hides a collapsed group without removing it from the document', async () => {
    const wrapper = mountNavigation();
    await wrapper.find('button[data-group="Generate"]').trigger('click');

    const list = wrapper.find('ul#panel-group-generate');
    expect(list.exists()).toBe(true);
    expect(list.isVisible()).toBe(false);
  });

  // The escape hatch. Whatever a visitor has collapsed, one click has to bring every panel back —
  // a collapsed group must never be the reason a panel cannot be found.
  it('restores every panel with expand all, after collapse all', async () => {
    const wrapper = mountNavigation();

    await wrapper.find('button[aria-label="Collapse all groups"]').trigger('click');
    for (const toggle of wrapper.findAll('button.group-toggle')) {
      expect(toggle.attributes('aria-expanded')).toBe('false');
    }

    await wrapper.find('button[aria-label="Expand all groups"]').trigger('click');
    for (const toggle of wrapper.findAll('button.group-toggle')) {
      expect(toggle.attributes('aria-expanded')).toBe('true');
    }
    for (const link of wrapper.findAll('a.panel-link')) {
      expect(link.isVisible()).toBe(true);
    }
  });

  // A presenter who tidies the sidebar before a demo should not have it spring back open on the
  // next reload, so the collapsed set survives a remount.
  it('remembers which groups were collapsed across a remount', async () => {
    const first = mountNavigation();
    await first.find('button[data-group="Generate"]').trigger('click');

    const second = mountNavigation();
    expect(second.find('button[data-group="Generate"]').attributes('aria-expanded')).toBe('false');
    expect(second.find('button[data-group="Understand"]').attributes('aria-expanded')).toBe('true');
  });

  // Storage can be disabled, full, or hold something an older build wrote. None of those are a
  // reason to render no navigation, so a bad value falls back to the documented default.
  it('falls back to fully expanded when the stored value is unusable', () => {
    globalThis.localStorage.setItem('playground.navigation.collapsed-groups', 'not json');

    for (const toggle of mountNavigation().findAll('button.group-toggle')) {
      expect(toggle.attributes('aria-expanded')).toBe('true');
    }
  });

  // Both controls are icon-only, so a tooltip is not enough: without an accessible name they are
  // announced as "button" and a screen-reader user has to activate one to find out which it was.
  it('names both bulk controls for assistive technology', () => {
    const wrapper = mountNavigation();
    const names = wrapper
      .findAll('button.group-control')
      .map((button) => button.attributes('aria-label'));

    expect(names).toEqual(['Expand all groups', 'Collapse all groups']);
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
