import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../src/client/views/AppShellView.tsx';

describe('resolveRoute', () => {
  it('resolves the editor for a diagram path', () => {
    expect(resolveRoute('/app/diagram/abc')).toEqual({ diagramId: 'abc', view: 'editor' });
  });

  it('resolves the editor for a trailing-slash diagram path', () => {
    expect(resolveRoute('/app/diagram/abc/')).toEqual({ diagramId: 'abc', view: 'editor' });
  });

  it('decodes a percent-encoded diagram id', () => {
    expect(resolveRoute('/app/diagram/a%20b')).toEqual({ diagramId: 'a b', view: 'editor' });
  });

  it.each(['/app/admin', '/app/admin/'])('resolves the admin view for %s', (pathname) => {
    expect(resolveRoute(pathname)).toEqual({ view: 'admin' });
  });

  // A plain SPA has no server-side router, so there is no client-side 404 within this subtree.
  // Falling back to the dashboard is the deliberate behaviour, not an oversight.
  it.each(['/app', '/app/', '/app/unknown', '/app/diagram', '/app/diagram/a/b'])(
    'falls back to the dashboard for %s',
    (pathname) => {
      expect(resolveRoute(pathname)).toEqual({ view: 'dashboard' });
    }
  );

  // Resolving to the admin route is not an authorization decision: every `/api/admin/*` route
  // re-checks the verified identity server-side. This test records that the client's answer is
  // presentational, so nobody later mistakes it for a gate.
  it('resolves the admin route without consulting any identity', () => {
    expect(resolveRoute('/app/admin')).toEqual({ view: 'admin' });
  });
});
