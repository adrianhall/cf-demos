import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount every component rendered by React Testing Library after each test. Registered
 * explicitly rather than relying on `@testing-library/react`'s auto-cleanup, since this project
 * does not enable Vitest's `globals` option.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom implements no `ResizeObserver`, which the real `@xyflow/react` requires to mount at all.
 * Every editor/blueprint component test mocks `@xyflow/react` outright (`./mock-xyflow.tsx`) and
 * never needs this, but `App.test.tsx` exercises the real module through `/blueprints`'s actual
 * rendering path end to end, so a global no-op polyfill belongs here rather than duplicated into
 * that one test file.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
