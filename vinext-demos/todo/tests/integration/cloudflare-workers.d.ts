import type worker from '../../src/worker/index';

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}

  interface Exports {
    /**
     * Default Hono application entry point supplied by the Workers test runtime.
     */
    default: typeof worker;
  }
}
