import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * DOM tests for the Vue SPA. Vuetify is inlined so its CSS imports and ESM build are processed by
 * Vite, and every test mounts components with a real `createVuetify()` instance rather than stubs.
 */
export default defineProject({
  plugins: [vue()],
  test: {
    name: 'client',
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    setupFiles: ['./setup.ts'],
    css: false,
    server: { deps: { inline: [/vuetify/] } }
  }
});
