/**
 * @file Test-only Worker module combining both Workers so a loopback service binding can connect
 *   them (see `./vitest.config.ts`).
 */

export { default } from '../../src/application-worker/index.ts';
export { DataEntrypoint } from '../../src/data-worker/index.ts';
