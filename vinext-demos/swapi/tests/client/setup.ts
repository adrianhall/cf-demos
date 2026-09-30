import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Unmount everything between tests.
 *
 * React Testing Library only registers this automatically when Vitest's `globals` option is on, and
 * it is not: this project imports `describe`/`it`/`expect` explicitly. Without it each test would
 * render into the same document as the last, and a query for a record name would find one match per
 * test that had rendered it.
 */
afterEach(cleanup);

/**
 * Jsdom implements neither of these, and both are used by code under test for real reasons: the
 * collection column scrolls a selected row into view, and it escapes the identifier it looks that
 * row up by. Stubbing them here rather than in each test keeps the stubbing out of the assertions,
 * and `scrollIntoView` is a `vi.fn()` so a test can assert it was called.
 */
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

if (typeof globalThis.CSS === 'undefined') {
  globalThis.CSS = {
    escape: (value: string) => value.replace(/["\\]/gu, '\\$&')
  } as unknown as typeof globalThis.CSS;
}
