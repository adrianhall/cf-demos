import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineProject({
  plugins: [vue()],
  test: { environment: 'jsdom', include: ['**/*.test.ts'], name: 'client' }
});
