/**
 * @file Runs the shared Data Worker contract against the real `DataEntrypoint`, reached through the
 *   `DATA_SERVICE` service binding and backed by real D1 with the committed migrations.
 */

import { env } from 'cloudflare:workers';
import { createDataClient } from '../../../src/application-worker/data-client.ts';
import { dataServiceContractTests } from '../../contract/data-service-contract.ts';
import { migrate, seedUser } from '../support.ts';

dataServiceContractTests('DataEntrypoint over RPC + D1', async () => {
  await migrate();
  return {
    service: createDataClient(env.DATA_SERVICE),
    addUser: async (email: string, role: string) => {
      await seedUser(email, role);
    }
  };
});
