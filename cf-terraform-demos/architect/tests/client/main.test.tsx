import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { THEME_STORAGE_KEY } from '../../src/client/lib/theme.ts';

/**
 * @file Covers the browser entry point. The module calls `startClient()` at import time, which is
 *   what makes it an entry point rather than a library. Each test therefore resets the module
 *   registry and imports it afresh, so the side effect is observed rather than suppressed.
 */

/**
 * Imports the entry point fresh, running its top-level `startClient()` call.
 *
 * @returns The module's exports.
 */
async function importEntryPoint(): Promise<typeof import('../../src/client/main.tsx')> {
  vi.resetModules();
  return import('../../src/client/main.tsx');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty('color-scheme');
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('startClient', () => {
  // `createRoot().render()` schedules the work rather than performing it, so the assertion is
  // wrapped in `act` to flush React's queue first. Without it this passes or fails on timing.
  it('mounts the application into #root', async () => {
    await act(async () => {
      await importEntryPoint();
    });

    expect(document.querySelector('#root')?.innerHTML).not.toBe('');
  });

  // The theme is applied before the first render rather than after it. Applying it afterwards
  // would paint one frame in the wrong scheme, which is the flash this ordering exists to avoid.
  it('applies a stored dark preference before rendering', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    await importEntryPoint();

    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies a stored light preference', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    await importEntryPoint();

    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  // No stored preference means the OS preference applies, which is the absence of an override
  // rather than an override naming the OS value.
  it('sets no override when nothing is stored', async () => {
    await importEntryPoint();

    expect(document.documentElement.style.colorScheme).toBe('');
  });

  // A missing `#root` means `index.html` and this entry point have gone out of sync. Failing
  // loudly is better than mounting nowhere and leaving a blank page with no explanation.
  it('throws a named error when the mount point is missing', async () => {
    document.body.innerHTML = '';

    await expect(importEntryPoint()).rejects.toThrow('#root element not found');
  });
});
