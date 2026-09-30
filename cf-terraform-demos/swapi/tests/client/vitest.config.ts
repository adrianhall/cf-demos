import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineProject({
  resolve: {
    // See tests/worker/vitest.config.ts for the full explanation. Client tests that validate the
    // Pothos schema must use the same CommonJS GraphQL instance as externalized Pothos, or
    // GraphQL's instanceof-based schema guard sees two realms and refuses a perfectly real schema.
    alias: { graphql: 'graphql/index.js' }
  },
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    name: 'client',
    setupFiles: ['./setup.ts'],
    server: { deps: { inline: [/vuetify/] } }
  }
});
