import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useIdentity } from '../../src/client/hooks/useIdentity.ts';

/**
 * @file Covers the only place the browser learns who it is. The behaviour worth pinning is that
 *   every answer comes from the server and a failure never produces a _partial_ identity: a hook
 *   that kept a stale email alongside an error, or defaulted `isAdmin` to anything but `false`,
 *   would let a failed request look like a successful one.
 */

/**
 * Stubs `fetch` with a single response.
 *
 * @param response Response the stub resolves with.
 * @returns The stub, so a test can assert how it was called.
 */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => response);
  vi.stubGlobal('fetch', stub);
  return stub;
}

/**
 * Stubs `fetch` with a JSON body and status.
 *
 * @param body Body to serialise.
 * @param status HTTP status.
 * @returns The stub.
 */
function stubJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return stubFetch(
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useIdentity', () => {
  it('starts in the loading state with no identity', () => {
    stubJson({ email: 'alice@example.com', isAdmin: false });

    const { result } = renderHook(() => useIdentity());

    expect(result.current).toEqual({
      email: null,
      error: null,
      isAdmin: false,
      loading: true
    });
  });

  it('reads the verified identity from GET /api/me', async () => {
    const fetchStub = stubJson({ email: 'alice@example.com', isAdmin: false });

    const { result } = renderHook(() => useIdentity());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current).toEqual({
      email: 'alice@example.com',
      error: null,
      isAdmin: false,
      loading: false
    });
    expect(fetchStub).toHaveBeenCalledWith('/api/me');
  });

  it('reports the administrator the server identified', async () => {
    stubJson({ email: 'admin@example.com', isAdmin: true });

    const { result } = renderHook(() => useIdentity());

    await waitFor(() => {
      expect(result.current.isAdmin).toBe(true);
    });
  });

  it('requests the identity exactly once per mount', async () => {
    const fetchStub = stubJson({ email: 'alice@example.com', isAdmin: false });

    const { result } = renderHook(() => useIdentity());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  describe('failure', () => {
    // The expected case on a public page: `/api/me` requires Access, so an anonymous visitor gets
    // a `401`. The hook reports it; the header decides whether that is an error worth showing.
    it('reports an unauthenticated response as a failure with no identity', async () => {
      stubJson({ detail: 'Authentication required.', status: 401 }, 401);

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.email).toBeNull();
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.error).toBe('Authentication required.');
    });

    // Prefers the RFC 9457 `detail` member, which was written to be shown.
    it('prefers the problem document detail as the message', async () => {
      stubJson({ detail: 'Your session has expired.', status: 401, title: 'Unauthorized' }, 401);

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.error).toBe('Your session has expired.');
      });
    });

    // Falls back to the status rather than inventing prose, and never renders a body that is not a
    // problem document — an upstream error page's HTML must not reach the banner.
    it.each([
      [JSON.stringify({ unexpected: 'shape' }), 503],
      ['<html>Gateway error</html>', 502],
      ['', 500]
    ])('falls back to the status for the unrecognised body %o', async (body, status) => {
      stubFetch(new Response(body, { status }));

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.error).toBe(`Request failed with status ${status}.`);
      });
    });

    it('reports a network failure with a safe message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Failed to fetch');
        })
      );

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.error).toBe('Failed to fetch');
      expect(result.current.email).toBeNull();
    });

    it('reports a non-Error rejection with its own fallback message', async () => {
      vi.stubGlobal(
        'fetch',
        // Rejecting with a non-Error is the point of this test: a thrown string is what a careless
        // caller or an older polyfill produces, and the hook must still render a safe message.
        vi.fn(() => Promise.reject('not an Error'))
      );

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.error).toBe('Could not verify your Cloudflare Access identity.');
      });
    });

    // Never a partial identity. A state carrying both an email and an error would render as
    // signed-in in one slot and broken in another.
    it('never reports an email alongside an error', async () => {
      stubJson({ detail: 'Authentication required.' }, 401);

      const { result } = renderHook(() => useIdentity());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.email).toBeNull();
    });
  });

  describe('unmounting', () => {
    // Committing state after unmount would resolve an identity into a tree that is no longer on
    // screen, which both warns and wastes the render.
    it('discards a response that arrives after unmount', async () => {
      let resolveFetch: ((response: Response) => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            })
        )
      );

      const { unmount } = renderHook(() => useIdentity());
      unmount();

      resolveFetch?.(
        new Response(JSON.stringify({ email: 'alice@example.com', isAdmin: false }), {
          headers: { 'content-type': 'application/json' }
        })
      );

      // Nothing to assert on the unmounted hook's state; the test passes by not producing an
      // update-after-unmount warning, which this project's setup surfaces as a console error.
      await expect(Promise.resolve()).resolves.toBeUndefined();
    });
  });
});
