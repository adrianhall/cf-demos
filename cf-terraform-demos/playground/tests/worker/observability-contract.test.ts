/**
 * @file The cross-panel observability contract, asserted across every delivered inference panel
 *   rather than panel by panel. Each phase checked its own logging, and each phase passed. That is
 *   exactly the failure mode phase 18 exists to catch: per-panel compliance does not add up to a
 *   consistent whole. A panel that names its correlation field `run_id` while every other names it
 *   `runId` looks perfectly correct in isolation and makes a cross-panel log search silently
 *   incomplete — the search returns results, just not all of them, which is worse than returning
 *   none. This suite is driven from the task catalogue, so a panel added in a later phase is
 *   covered the moment it is marked available. That is the property that makes it worth writing: a
 *   test listing today's fourteen panels would pass forever while the fifteenth drifted. It reads
 *   source rather than running the routes deliberately. What is being asserted is a naming and
 *   structural convention across files, and the alternative — dispatching every panel through a
 *   real isolate with a capturing logger — would need a valid request fixture per panel and would
 *   still only cover the paths those fixtures reached. The weaker check that holds for every panel
 *   is the more useful one here.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_DESCRIPTORS, type TaskDescriptor } from '../../src/shared/tasks';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * The field name every panel must use to correlate its log lines.
 *
 * One search on a run identifier has to return the whole story of a request, which it cannot do if
 * two panels spell the field differently.
 */
const RUN_ID_FIELD = 'runId';

/**
 * Every inference panel that is built, which is the set this contract holds for.
 *
 * View Tokens is excluded by the `gateway: 'required'` filter rather than by name: it performs no
 * inference, so it has no model call to log an attempt before.
 */
const deliveredInferencePanels: TaskDescriptor[] = TASK_DESCRIPTORS.filter(
  (task) => task.availability === 'available' && task.gateway === 'required'
);

/**
 * Reads a panel's route module.
 *
 * The route file is named for the task identifier throughout this demo, which is what lets this
 * suite find a future panel's logging without being told where it lives.
 *
 * @param task The panel to read.
 * @returns The route module's source.
 * @throws {Error} When no route file matches the task identifier, which means either the panel is
 *   marked available without a route or the naming convention has been broken — both worth failing
 *   on rather than skipping.
 */
async function routeSource(task: TaskDescriptor): Promise<string> {
  const file = path.join(demoRoot, 'src/worker/routes', `${task.id}.ts`);

  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new Error(
      `No route module found at src/worker/routes/${task.id}.ts for the delivered panel "${task.name}".`
    );
  }
}

describe('cross-panel observability contract', () => {
  // A guard on the guard: if this ever reads zero, every assertion below would pass by iterating
  // over nothing.
  it('covers every delivered inference panel', () => {
    expect(deliveredInferencePanels.length).toBeGreaterThan(10);
  });

  describe.each(deliveredInferencePanels.map((task) => [task.name, task] as const))(
    '%s',
    (_name, task) => {
      /**
       * The event name convention: one `<task>_run_started` per panel, derived from the task
       * identifier so it cannot be a near-miss spelling of it.
       */
      const eventPrefix = task.id.replaceAll('-', '_');

      it('logs an attempt before the model is called', async () => {
        const source = await routeSource(task);

        // The start line is what distinguishes a request that failed inside the provider from one
        // that was never made. Its absence is invisible until the day it matters.
        expect(source).toContain(`'${eventPrefix}_run_started'`);
      });

      it('logs a failure under the shared naming convention', async () => {
        const source = await routeSource(task);

        expect(source).toContain(`'${eventPrefix}_run_failed'`);
      });

      it('correlates on the shared run-identifier field', async () => {
        const source = await routeSource(task);

        // Asserted as a field rather than merely as a mentioned word: `runId:` is the log key,
        // while `request.runId` alone would satisfy a looser check without any line carrying it.
        expect(source).toMatch(new RegExp(`${RUN_ID_FIELD}:`, 'u'));
      });

      it('uses no alternative spelling of the correlation field', async () => {
        const source = await routeSource(task);

        // The actual regression this file exists for. A panel spelling it `run_id` would log
        // correctly, read correctly, and quietly fall out of every cross-panel search.
        expect(source).not.toMatch(/\brun_id\s*:/u);
        expect(source).not.toMatch(/\brunID\s*:/u);
      });

      it('binds the cause of a failure rather than discarding it', async () => {
        const source = await routeSource(task);

        // Every panel wraps its service call, and a bare `catch {` there would throw away the only
        // description of what the provider actually complained about.
        expect(source).not.toMatch(/catch\s*\{/u);
      });
    }
  );

  // Asserted once across all panels rather than per panel, because the failure is a mismatch
  // between two files rather than a defect in either.
  it('emits exactly one start event per delivered panel, with no orphans', async () => {
    const sources = await Promise.all(
      deliveredInferencePanels.map(async (task) => routeSource(task))
    );
    const emitted = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/'([a-z_]+)_run_started'/gu)].map((m) => m[1])
      )
    );
    const expected = new Set(deliveredInferencePanels.map((task) => task.id.replaceAll('-', '_')));

    // Set equality in both directions: a missing event means a panel logs no attempt, and an extra
    // one means an event survived a panel being renamed and now correlates with nothing.
    expect([...emitted].sort()).toEqual([...expected].sort());
  });

  it('logs neither prompt content nor the verified email from any panel route', async () => {
    const sources = await Promise.all(
      deliveredInferencePanels.map(async (task) => routeSource(task))
    );

    for (const source of sources) {
      // Scoped to the argument of a logging call rather than to the file. Every route legitimately
      // writes `email: identity.email` when assembling the actor for gateway metadata — that is
      // the attribution the demo makes deliberately — so a file-wide search for the word would
      // flag the correct code and have to be suppressed, which is how a guard becomes noise.
      //
      // Written as "must not contain", because that is the direction that silently rots: a panel
      // that starts logging an email still passes every test asserting what it *does* log.
      for (const call of source.matchAll(/logger\.\w+\((?<args>[^;]*?)\n\s*\}\);/gsu)) {
        const args = call.groups?.['args'] ?? '';

        expect(args).not.toMatch(/\bemail\b/u);
        expect(args).not.toMatch(/\bidentity\./u);
        expect(args).not.toMatch(/\bactor\./u);
      }
    }
  });
});
