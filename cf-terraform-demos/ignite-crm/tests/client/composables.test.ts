/**
 * @file Corner cases of the SPA's shared composables: a superseded record-link search or resource
 *   load never overwrites newer state (the race a fast typist or a quick navigation produces),
 *   unexpected non-API failures become safe generic `ApiError`s, and an already-loaded session is
 *   not re-fetched until it is explicitly reloaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useLinkSearch } from '../../src/client/composables/useLinkSearch.ts';
import { useResource } from '../../src/client/composables/useResource.ts';
import { resetSession, useSession } from '../../src/client/composables/useSession.ts';
import { ApiClient, ApiError } from '../../src/client/services/api-client.ts';
import { DEFAULT_CONFIGURATION, toDisplayConfiguration } from '../../src/configuration.ts';

const search = vi.hoisted(() => ({
  calls: [] as { text: string; resolve: (value: unknown) => void; reject: (e: unknown) => void }[]
}));

vi.mock('../../src/client/services/link-search.ts', () => ({
  searchLinkOptions: (_type: string, text: string) =>
    new Promise((resolve, reject) => search.calls.push({ text, resolve, reject }))
}));

beforeEach(() => {
  search.calls.length = 0;
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLinkSearch', () => {
  it('keeps only the newest search, whether the older one resolves or fails later', async () => {
    const state = useLinkSearch();
    const first = state.search('contact', 'a');
    const second = state.search('contact', 'ad');
    search.calls[1]!.resolve([{ type: 'contact', id: 'new', label: 'Ada' }]);
    await second;
    search.calls[0]!.resolve([{ type: 'contact', id: 'old', label: 'Stale' }]);
    await first;
    expect(state.results.value.map((item) => item.id)).toEqual(['new']);
    expect(state.searching.value).toBe(false);

    const failing = state.search('contact', 'x');
    const winning = state.search('contact', 'xy');
    search.calls[3]!.resolve([]);
    await winning;
    search.calls[2]!.reject(new ApiError('server', 'late failure', 500));
    await failing;
    expect(state.error.value).toBeNull();
  });

  it('turns an unexpected failure into a generic, safe error', async () => {
    const state = useLinkSearch();
    const pending = state.search('deal', 'q');
    search.calls[0]!.reject(new TypeError('internal detail'));
    await pending;
    expect(state.error.value?.message).toBe('Could not search records.');
    expect(state.results.value).toEqual([]);
  });
});

describe('useResource', () => {
  it('ignores a superseded load, even when it fails, and reports a non-API failure generically', async () => {
    const resolvers: { resolve: (value: string) => void; reject: (e: unknown) => void }[] = [];
    let resource!: ReturnType<typeof useResource<string>>;
    const wrapper = mount(
      defineComponent({
        setup() {
          resource = useResource(
            () => new Promise<string>((resolve, reject) => resolvers.push({ resolve, reject }))
          );
          return () => h('div');
        }
      })
    );
    const older = resource.load();
    const newer = resource.load();
    resolvers[1]!.resolve('fresh');
    await newer;
    resolvers[0]!.reject(new Error('aborted request'));
    await older;
    expect(resource.data.value).toBe('fresh');
    expect(resource.state.value).toBe('success');

    const failing = resource.load();
    resolvers[2]!.reject(new RangeError('boom'));
    await failing;
    expect(resource.state.value).toBe('error');
    expect(resource.error.value?.message).toBe('Something went wrong.');
    wrapper.unmount();
  });
});

describe('useSession', () => {
  it('loads once, reuses the ready session, joins labels, and reloads on request', async () => {
    let sessions = 0;
    const client = new ApiClient((input) => {
      if (input === '/api/v1/session') {
        sessions++;
        return Promise.resolve(
          Response.json({
            user: {
              id: '00000000-0000-4000-8000-000000000001',
              email: 'm@example.com',
              displayName: 'M'
            },
            roles: [
              { id: 'manager', label: 'Manager' },
              { id: 'sales', label: 'Sales representative' }
            ],
            permissions: ['crm.read']
          })
        );
      }
      return Promise.resolve(Response.json(toDisplayConfiguration(DEFAULT_CONFIGURATION)));
    });
    const session = useSession();
    expect(session.roleLabel.value).toBe('');
    await session.load(client);
    expect(session.state.value).toBe('ready');
    expect(session.roleLabel.value).toBe('Manager, Sales representative');
    await session.load(client);
    expect(sessions).toBe(1);
    await session.reload(client);
    expect(sessions).toBe(2);
  });

  it('reports a non-API failure as a generic session error', async () => {
    const broken = new ApiClient(() => Promise.reject(new TypeError('network internals')));
    vi.spyOn(broken, 'session').mockRejectedValue(new TypeError('network internals'));
    const session = useSession();
    await session.load(broken);
    expect(session.state.value).toBe('error');
    expect(session.error.value?.message).toBe('Could not load your session.');
  });
});
