/**
 * @file Runs the shared Data Worker contract against the in-memory fake.
 */

import type { Role } from '../../src/shared/permissions.ts';
import { createFakeDataService } from '../fakes/fake-data-service.ts';
import { dataServiceContractTests } from './data-service-contract.ts';

dataServiceContractTests('FakeDataService', () => {
  const { service, store } = createFakeDataService();
  return Promise.resolve({
    service,
    addUser: (email: string, role: string) => {
      store.addUser(email, role as Role);
      return Promise.resolve();
    }
  });
});
