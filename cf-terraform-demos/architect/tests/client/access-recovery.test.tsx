import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import {
  ACCESS_RECOVERY_QUERY,
  AccessRecoveryPage,
  beginAccessRecovery,
  resumeAccessRecovery,
  takeRecoveredApiResult
} from '../../src/client/api/access-recovery.ts';

/**
 * @file Covers the one-request Access continuation shared by every authenticated JSON API call. A
 *   `fetch` cannot follow Cloudflare Access's HTML sign-in flow, so this deliberately crosses a
 *   real document navigation: save one JSON request, visit protected `/app`, replay after Access
 *   has returned, then let the original page consume that one result. These tests own storage,
 *   navigation and loop prevention; each API module's own suite proves it invokes the shared seam
 *   on `401`.
 */

/**
 * Original browser location descriptor, restored after every test.
 */
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * Installs a controllable same-origin location.
 *
 * @param pathname Page currently using the API.
 * @returns The navigation spies.
 */
function installLocation(pathname = '/blueprints'): {
  assign: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
} {
  const assign = vi.fn();
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      assign,
      hash: '',
      href: `https://architect.test${pathname}`,
      pathname,
      replace,
      search: ''
    },
    writable: true
  });
  return { assign, replace };
}

beforeEach(() => {
  sessionStorage.clear();
  installLocation();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('beginAccessRecovery', () => {
  it('stores one JSON request and enters the existing Access-gated app route', () => {
    const { assign } = installLocation('/blueprints?category=AI#gallery');

    beginAccessRecovery('/api/diagrams', {
      body: JSON.stringify({ title: 'Architecture' }),
      method: 'POST'
    });

    expect(assign).toHaveBeenCalledWith(`/app?${ACCESS_RECOVERY_QUERY}=1`);
    expect(sessionStorage.getItem('architect.pending-api-request')).toEqual(
      JSON.stringify({
        body: JSON.stringify({ title: 'Architecture' }),
        method: 'POST',
        path: '/api/diagrams',
        returnTo: '/blueprints?category=AI#gallery',
        version: 1
      })
    );
  });

  it('refuses a body it cannot faithfully serialise across a document navigation', () => {
    expect(() =>
      beginAccessRecovery('/api/diagrams', { body: new URLSearchParams({ q: 'x' }) })
    ).toThrow('non-JSON body');
  });
});

describe('resumeAccessRecovery', () => {
  it('replays the saved request once and returns to the page that started it', async () => {
    const { replace } = installLocation('/app');
    sessionStorage.setItem(
      'architect.pending-api-request',
      JSON.stringify({
        body: JSON.stringify({ title: 'Architecture' }),
        method: 'POST',
        path: '/api/diagrams',
        returnTo: '/blueprints',
        version: 1
      })
    );
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(new Response(JSON.stringify({ diagram: { id: 'd1' } }), { status: 201 }));

    await resumeAccessRecovery();

    expect(fetchMock).toHaveBeenCalledWith('/api/diagrams', {
      body: JSON.stringify({ title: 'Architecture' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(replace).toHaveBeenCalledWith('/blueprints');
    expect(sessionStorage.getItem('architect.pending-api-request')).toBeNull();
    expect(
      takeRecoveredApiResult('/api/diagrams', {
        body: JSON.stringify({ title: 'Architecture' }),
        method: 'POST'
      })
    ).toEqual({ body: { diagram: { id: 'd1' } }, ok: true });
  });

  // Consuming a failed replay is what stops a stale/invalid Access cookie from producing a sign-in
  // loop: this result becomes the normal request error on the original page, never another redirect.
  it('preserves a failed replay for one normal error path without re-queuing it', async () => {
    const { replace } = installLocation('/app');
    sessionStorage.setItem(
      'architect.pending-api-request',
      JSON.stringify({
        body: null,
        method: 'GET',
        path: '/api/diagrams',
        returnTo: '/blueprints',
        version: 1
      })
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Still not signed in.' }), { status: 401 })
    );

    await resumeAccessRecovery();

    expect(replace).toHaveBeenCalledWith('/blueprints');
    expect(takeRecoveredApiResult('/api/diagrams')).toEqual({
      body: { detail: 'Still not signed in.' },
      ok: false
    });
    expect(takeRecoveredApiResult('/api/diagrams')).toBeNull();
  });

  it('does not replay a malformed or cross-origin staged request', async () => {
    const { replace } = installLocation('/app');
    sessionStorage.setItem(
      'architect.pending-api-request',
      JSON.stringify({
        body: null,
        method: 'GET',
        path: 'https://evil.test/',
        returnTo: '//evil.test/',
        version: 1
      })
    );

    await resumeAccessRecovery();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('runs the continuation page once it is mounted', async () => {
    const { replace } = installLocation('/app');
    sessionStorage.setItem(
      'architect.pending-api-request',
      JSON.stringify({
        body: null,
        method: 'GET',
        path: '/api/diagrams',
        returnTo: '/blueprints',
        version: 1
      })
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ diagrams: [] })));

    const { container } = render(<AccessRecoveryPage />);

    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/blueprints'));
  });
});
