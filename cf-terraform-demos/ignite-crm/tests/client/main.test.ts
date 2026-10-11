/**
 * @file The SPA entry mounts the shell into `#app`.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { resetSession } from '../../src/client/composables/useSession.ts';
import { settle, useApi } from './support.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  resetSession();
  document.body.innerHTML = '';
});

it('mounts the application shell', async () => {
  const store = useApi('owner@example.com');
  store.addUser('owner@example.com', 'owner');
  document.body.innerHTML = '<div id="app"></div>';
  await import('../../src/client/main.ts');
  await settle();
  expect(document.body.textContent).toContain('Ignite CRM');
  expect(document.body.textContent).toContain('Owner');
});
