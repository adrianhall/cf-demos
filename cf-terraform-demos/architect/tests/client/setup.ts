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
