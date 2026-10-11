/**
 * @file Client test helpers: mount with a real Vuetify instance and router, over a fake `fetch`
 *   backed by the Application Worker's real Hono app and the fake Data Worker. The one substitution
 *   is identity: jsdom's realm breaks `jose`'s key type checks, so instead of signing a development
 *   JWT the app is given a middleware that sets the verified-identity variable the real Access
 *   middleware would set. Access verification itself is covered by the unit (`tests/unit/api`) and
 *   Workers-runtime suites.
 */

import type { MiddlewareHandler } from 'hono';
import { vi } from 'vitest';
import { type Component, h } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';
import { VApp } from 'vuetify/components';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createApiApp } from '../../src/application-worker/api/app.ts';
import type { ApiEnv } from '../../src/application-worker/api/context.ts';
import { createAppRouter } from '../../src/client/router/index.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import type { DataService } from '../../src/shared/data-service/contract.ts';
import { createFakeDataService, type FakeStore } from '../fakes/fake-data-service.ts';

/**
 * Route `fetch` to the real API app over the fake Data Worker, signed in as one identity.
 *
 * @param email Identity to sign requests as.
 * @param data Data service (defaults to a fresh fake).
 * @returns The store, for seeding and assertions.
 */
export function useApi(
  email: string,
  data?: { service: DataService; store: FakeStore }
): FakeStore {
  const fake = data ?? createFakeDataService();
  const identity: MiddlewareHandler<ApiEnv> = async (context, next) => {
    context.set('Cloudflare_Access_Identity', { email, sub: 'test', source: 'header' });
    await next();
  };
  const app = createApiApp({
    access: identity,
    dataService: () => fake.service,
    includeStack: false
  });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    await Promise.resolve();
    const headers = new Headers(init.headers);
    if ((init.method ?? 'GET') !== 'GET') {
      headers.set('Origin', 'https://crm.test');
    }
    return app.request(`https://crm.test${input}`, { ...init, headers }, { ACCESS_AUD: 'test' });
  });
  return fake.store;
}

/**
 * Mount a component inside `v-app` with Vuetify and a memory-history router.
 *
 * @param component The component.
 * @param options Props and initial route.
 * @returns The wrapper and router.
 */
export async function mountWithApp(
  component: Component,
  options: { props?: Record<string, unknown>; route?: string } = {}
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createAppRouter(createMemoryHistory());
  await router.push(options.route ?? '/');
  await router.isReady();
  const wrapper = mount(
    { render: () => h(VApp, () => h(component, options.props ?? {})) },
    {
      attachTo: document.body,
      global: { plugins: [router, createAppVuetify()] }
    }
  );
  await settle();
  return { wrapper, router };
}

/**
 * Let promises, timers, and re-renders settle.
 *
 * @returns Once settled.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
