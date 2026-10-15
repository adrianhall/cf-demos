import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  options: { typeAware: true, typeCheck: true }
});
