/**
 * @file The metadata contract, asserted across every delivered inference panel rather than against
 *   one example. Phase 3 delivers a single inference panel, so this suite could trivially have
 *   tested Chat alone — but the regression worth preventing is a _future_ panel that forgets the
 *   verified email, and a test written against one panel cannot catch that. Driving it from the
 *   catalogue means a panel added later is covered the moment it is marked available.
 */

import { describe, expect, it } from 'vitest';
import { TASK_DESCRIPTORS, type TaskDescriptor } from '../../src/shared/tasks';
import { modelsForTask } from '../../src/worker/domain/models';
import { buildGatewayMetadata } from '../../src/worker/infrastructure/ai/gateway-metadata';

/**
 * Every inference panel that is built, which is the set this contract has to hold for.
 */
const deliveredInferencePanels: TaskDescriptor[] = TASK_DESCRIPTORS.filter(
  (task) => task.availability === 'available' && task.gateway === 'required'
);

/**
 * The verified identity used throughout.
 */
const ACTOR = { email: 'alice@example.com', sub: 'sub-alice' };

describe('AI Gateway metadata contract', () => {
  // A guard on the guard: if this ever reads zero, the suite below would pass by testing nothing.
  it('covers at least one delivered inference panel', () => {
    expect(deliveredInferencePanels.length).toBeGreaterThan(0);
  });

  describe.each(deliveredInferencePanels.map((task) => [task.name, task] as const))(
    '%s',
    (_name, task) => {
      /**
       * The panel's first reviewed model, which supplies the contract version.
       */
      const model = modelsForTask(task.id)[0]!;

      it('has a reviewed model to build metadata from', () => {
        expect(model).toBeDefined();
      });

      it('records the verified email, the panel, and the run', () => {
        const metadata = buildGatewayMetadata(task.id, 'run-1', ACTOR, model.contractVersion);

        expect(metadata).toEqual({
          task: task.id,
          runId: 'run-1',
          user: 'alice@example.com',
          contractVersion: model.contractVersion
        });
      });

      // An unattributable request to a paid provider is the failure this refuses to allow. Failing
      // the request is the correct response, not sending it anonymously.
      it('refuses to build metadata with no verified email', () => {
        expect(() =>
          buildGatewayMetadata(task.id, 'run-1', { email: '', sub: 'x' }, model.contractVersion)
        ).toThrow(/verified user/iu);
      });

      // A whitespace-only email would pass a naive truthiness check and reach the gateway as a
      // blank attribution, which is worse than an outright failure because it looks like a value.
      it('refuses to build metadata from a whitespace-only email', () => {
        expect(() =>
          buildGatewayMetadata(task.id, 'run-1', { email: '   ', sub: 'x' }, model.contractVersion)
        ).toThrow(/verified user/iu);
      });

      // The metadata is the one place this demo records a personal field, so it must be the *only*
      // one: no prompt, no answer, no file name, no upload.
      it('records no field beyond the four in the contract', () => {
        const metadata = buildGatewayMetadata(task.id, 'run-1', ACTOR, model.contractVersion);
        expect(Object.keys(metadata).sort()).toEqual(['contractVersion', 'runId', 'task', 'user']);
      });

      it('distinguishes two identities asking the same thing', () => {
        const first = buildGatewayMetadata(task.id, 'run-1', ACTOR, model.contractVersion);
        const second = buildGatewayMetadata(
          task.id,
          'run-1',
          { email: 'bob@example.com', sub: 'sub-bob' },
          model.contractVersion
        );

        expect(first.user).not.toBe(second.user);
      });
    }
  );
});
