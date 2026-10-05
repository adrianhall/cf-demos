import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { buildRoutes, createAppRouter } from '../../src/client/router';
import { TASK_DESCRIPTORS } from '../../src/shared/tasks';

describe('buildRoutes', () => {
  it('creates a route for every panel', () => {
    const paths = buildRoutes().map((route) => route.path);
    for (const task of TASK_DESCRIPTORS) {
      expect(paths).toContain(`/${task.id}`);
    }
  });

  // One level deep, by construction. A nested route would mean a panel that can only be reached
  // through another one, which is the "studio with tabs" shape this product rejected.
  it('nests no route beneath another', () => {
    for (const route of buildRoutes()) {
      expect(route.children).toBeUndefined();
    }
  });

  it('routes the activity page', () => {
    expect(buildRoutes().map((route) => route.path)).toContain('/activity');
  });

  // Every panel in the catalogue is built, so every route must resolve to a real component. The
  // placeholder that used to absorb a missing view is gone: a panel listed in the sidebar with no
  // view behind it is now a defect, and this is where it surfaces. TypeScript catches the same
  // mistake at build time via the total `Record<TaskId, …>`; this holds it at runtime too, so a
  // route table assembled some other way cannot reintroduce the gap.
  it('resolves every panel route to a view of its own', () => {
    const routes = buildRoutes();
    const components = new Set<unknown>();

    for (const task of TASK_DESCRIPTORS) {
      const route = routes.find((candidate) => candidate.path === `/${task.id}`);
      expect(route?.component, `${task.name} needs its own view`).toBeDefined();
      components.add(route?.component);
    }

    // Distinct components, which is what rules out a single shared stand-in quietly serving
    // several panels — the exact shape the old placeholder had.
    expect(components.size).toBe(TASK_DESCRIPTORS.length);
  });
});

describe('createAppRouter', () => {
  /**
   * Creates a router over an in-memory history, already settled on a starting route.
   *
   * A memory history has no initial location to resolve, so `isReady()` alone never settles — the
   * first navigation has to be performed explicitly. Pushing to the activity page rather than `/`
   * gives each test a neutral starting point that is not the redirect target it is about to assert
   * on.
   *
   * @returns A router that has completed its first navigation.
   */
  async function readyRouter() {
    const router = createAppRouter(createMemoryHistory());
    await router.push('/activity');
    await router.isReady();
    return router;
  }

  // The root lands on the one panel that works rather than an empty overview, so a visitor's
  // first click is not spent getting somewhere useful.
  it('sends the root path to View Tokens', async () => {
    const router = await readyRouter();
    await router.push('/');
    expect(router.currentRoute.value.path).toBe('/view-tokens');
  });

  it.each(TASK_DESCRIPTORS.map((task) => task.id))('navigates to /%s', async (taskId) => {
    const router = await readyRouter();
    await router.push(`/${taskId}`);
    expect(router.currentRoute.value.path).toBe(`/${taskId}`);
  });

  it('passes the panel identifier to the view as a prop', async () => {
    const router = await readyRouter();
    await router.push('/classify-image');
    expect(router.currentRoute.value.meta.taskId).toBe('classify-image');
  });

  // The browser tab and a screen reader's navigation announcement have to say which of the fifteen
  // panels is open, not merely "Playground" for every route.
  it('names a panel in the document title', async () => {
    const router = await readyRouter();
    await router.push('/describe-image');

    expect(document.title).toBe('Describe Image — Playground');
  });

  it('updates the document title on navigation', async () => {
    const router = await readyRouter();
    await router.push('/create-image');
    expect(document.title).toBe('Create Image — Playground');

    await router.push('/chat');
    expect(document.title).toBe('Chat — Playground');
  });

  // A single-page application has to move focus itself. A full page load resets focus to the top
  // of the document; a client-side route change does not, so without this a keyboard user who
  // activates a sidebar link keeps focus on that link and would tab through the remaining panel
  // links before reaching the panel they chose. A screen-reader user hears the title change while
  // their reading position stays in the navigation list.
  it('moves focus to the main landmark on navigation', async () => {
    const main = document.createElement('main');
    main.id = 'main-content';
    main.tabIndex = -1;
    // `appendChild` rather than `append`: this project's generated Workers types put a global
    // `append` in scope whose signature expects a `Response`, so the DOM call does not type-check.
    document.body.appendChild(main);

    const link = document.createElement('a');
    link.href = '#';
    document.body.appendChild(link);
    link.focus();
    expect(document.activeElement).toBe(link);

    const router = await readyRouter();
    await router.push('/classify-image');

    expect(document.activeElement).toBe(main);

    main.remove();
    link.remove();
  });

  // Activity is not a task descriptor, so it keeps the application-level title rather than being
  // assigned a stale panel name from the route that preceded it.
  it('uses the application title for a non-panel route', async () => {
    const router = await readyRouter();
    await router.push('/create-image');
    await router.push('/activity');

    expect(document.title).toBe('Playground');
  });

  // A mistyped URL is routine. Landing on the working panel is friendlier than a blank screen and
  // avoids a dedicated not-found page that nobody would read.
  it('redirects an unknown path to View Tokens', async () => {
    const router = await readyRouter();
    await router.push('/not-a-panel');
    expect(router.currentRoute.value.path).toBe('/view-tokens');
  });
});
