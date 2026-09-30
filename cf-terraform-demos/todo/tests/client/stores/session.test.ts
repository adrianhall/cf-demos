import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/client/stores/session';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session store', () => {
  it("records the Worker's verified identity", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: 'alice@example.com' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );
    const store = useSessionStore();

    await store.load();

    expect(fetchMock).toHaveBeenCalledWith('/api/me');
    expect(store.email).toBe('alice@example.com');
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  // A 401 here means the Access session has expired. The header simply stops showing an identity
  // rather than the page breaking, which is why the failure is recorded instead of thrown.
  it.each([401, 403, 500])('clears the identity on a %s response', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    const store = useSessionStore();

    await store.load();

    expect(store.email).toBeNull();
    expect(store.error).toBe('Your session could not be verified.');
    expect(store.loading).toBe(false);
  });

  it('clears the identity when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const store = useSessionStore();

    await store.load();

    expect(store.email).toBeNull();
    expect(store.error).toBe('network down');
    expect(store.loading).toBe(false);
  });
});
