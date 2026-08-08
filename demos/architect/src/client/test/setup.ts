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
