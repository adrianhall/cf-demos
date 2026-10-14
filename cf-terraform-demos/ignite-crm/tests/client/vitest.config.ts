import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { workersAliases } from '../workers-aliases.ts';

/**
 * DOM tests for the Vue SPA. Vuetify is inlined so its CSS imports and ESM build are processed by
 * Vite, and every test mounts components with a real `createVuetify()` instance rather than stubs.
 *
 * These tests serve the SPA's `fetch` from the real Hono app, whose import graph reaches
 * Workers-only modules since the chat feature, so those are aliased (see `../workers-aliases.ts`).
 */
export default defineProject({
  plugins: [vue()],
  resolve: { alias: [...workersAliases] },
  test: {
    name: 'client',
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    setupFiles: ['./setup.ts'],
    css: false,
    server: { deps: { inline: [/vuetify/] } }
  }
});
