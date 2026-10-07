import type worker from '../../src/worker/index.ts';

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}

  interface Exports {
    default: typeof worker;
  }
}
