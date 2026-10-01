import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { buildRoutes, createAppRouter } from '../../src/client/router';
import { TASK_DESCRIPTORS } from '../../src/tasks';

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

  // The sidebar promises a working panel; the router has to deliver one. Without this, marking a
  // panel `available` in the catalogue and forgetting to register its view would produce a badge
  // saying "ready" above a page saying "not built yet".
  it('gives every panel marked available a view of its own', () => {
    const routes = buildRoutes();
    const placeholder = routes.find((route) => route.path === '/chat')?.component;

    for (const task of TASK_DESCRIPTORS.filter((item) => item.availability === 'available')) {
      const route = routes.find((candidate) => candidate.path === `/${task.id}`);
      expect(route?.component, `${task.name} needs its own view`).not.toBe(placeholder);
    }
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

  // A mistyped URL is routine. Landing on the working panel is friendlier than a blank screen and
  // avoids a dedicated not-found page that nobody would read.
  it('redirects an unknown path to View Tokens', async () => {
    const router = await readyRouter();
    await router.push('/not-a-panel');
    expect(router.currentRoute.value.path).toBe('/view-tokens');
  });
});
