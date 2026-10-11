/**
 * Data Worker (`ignite-crm-data`) configuration: the private RPC service that owns the D1 database.
 *
 * Settings live in `./worker-settings.ts` so the Vite plugin (which only reads the demo-root
 * `cloudflare.config.ts` directly) runs and builds exactly this Worker as an auxiliary Worker. This
 * file exists so that `cf workers types` can generate the Data Worker's own types (run from this
 * directory), and so the Application Worker's `DATA_SERVICE` binding can reference this definition
 * and be typed from the real `DataEntrypoint` class.
 */

import { defineConfig, defineWorker } from 'cf/config';
import { readOutputs } from '../infra/outputs.ts';
import * as entrypoint from '../src/data-worker/index.ts' with { type: 'cf-worker' };
import { dataWorkerSettings } from './worker-settings.ts';

/**
 * The Data Worker definition, exported separately so `../cloudflare.config.ts` can bind to it.
 */
export const dataWorker = defineWorker((ctx) =>
  dataWorkerSettings(readOutputs(ctx.mode), ctx.mode === 'production', entrypoint)
);

export default defineConfig({ worker: dataWorker });
