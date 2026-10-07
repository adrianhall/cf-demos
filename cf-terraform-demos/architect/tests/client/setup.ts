/**
 * @file Client test setup. jsdom applies no stylesheets and has no font metrics, so nothing in this
 *   project can observe a CSS regression. That is deliberate rather than a gap: the
 *   built-stylesheet contract in `../build/built-css.test.ts` owns that, and geometry is reviewed
 *   in a real browser. These tests assert structure and behaviour only.
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// React Testing Library mounts into a container it appends to `document.body`. Without an
// explicit unmount between tests, a query such as `getByRole` sees every previously rendered
// tree as well and fails on a duplicate match that has nothing to do with the test at hand.
afterEach(() => {
  cleanup();
});

// jsdom implements no `ResizeObserver`, which the real `@xyflow/react` needs in order to mount at
// all. Most component tests replace the module outright with `./mock-xyflow.tsx`, but the path
// selector and view suites deliberately render the genuine article end to end — a gallery that
// threw on mount would otherwise pass those tests while failing in a browser. A no-op global
// belongs here rather than in each of those files, since none of them is about resize behaviour.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    /**
     * @returns Nothing. jsdom reports no geometry, so there is nothing to observe.
     */
    observe(): void {}

    /**
     * @returns Nothing.
     */
    unobserve(): void {}

    /**
     * @returns Nothing.
     */
    disconnect(): void {}
  };
}
