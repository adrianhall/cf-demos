import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/client/stores/session';

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the verified identity the Worker reported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ email: 'alice@example.com' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );

    const session = useSessionStore();
    await session.load();

    expect(session.email).toBe('alice@example.com');
    expect(session.error).toBeNull();
  });

  // An expired Access session shows up here as a 401, which is how the UI notices it without
  // any separate session-expiry mechanism.
  it('reports an expired session without an identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 401, detail: 'Authentication required.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/problem+json' }
        })
      )
    );

    const session = useSessionStore();
    await session.load();

    expect(session.email).toBeNull();
    expect(session.error).toBe('Authentication required.');
  });

  it('clears loading even when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const session = useSessionStore();
    await session.load();

    expect(session.loading).toBe(false);
    expect(session.error).toBe('offline');
  });
});
