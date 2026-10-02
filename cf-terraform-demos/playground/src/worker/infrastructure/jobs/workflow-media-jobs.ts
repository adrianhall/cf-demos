/**
 * @file Workflows-backed implementation of {@link MediaJobPort}. Thin by design: its whole job is
 *   to call the binding and translate the platform's status vocabulary into this demo's, using the
 *   exhaustive mapping in `domain/media-job.ts`. The translation is kept in the domain rather than
 *   here so it can be tested against the full documented status list without a Workflow binding in
 *   the way.
 */

import type { MediaJobPort, MediaJobStatus } from '../../application/ports/media-job-port';
import { mediaJobStateFromWorkflow } from '../../domain/media-job';

/**
 * Runs media jobs as Workflow instances.
 */
export class WorkflowMediaJobs implements MediaJobPort {
  readonly #workflow: Workflow;

  /**
   * @param workflow The Workflow binding, supplied by the composition root.
   */
  constructor(workflow: Workflow) {
    this.#workflow = workflow;
  }

  /**
   * Creates a Workflow instance under the derived identifier.
   *
   * @param jobId Derived job identifier, used as the instance ID.
   * @param params Parameters serialised into instance state.
   * @returns A promise fulfilled once the instance exists.
   * @throws {Error} When the binding refuses the creation, including when an instance already
   *   exists under the identifier.
   */
  async start(jobId: string, params: unknown): Promise<void> {
    await this.#workflow.create({ id: jobId, params: params as Record<string, unknown> });
  }

  /**
   * Reads an instance's status and translates it.
   *
   * A missing instance is reported as `undefined` rather than as a failure. That distinction is the
   * ownership check: the status route derives the identifier from the _current_ verified identity,
   * so a visitor asking after someone else's run derives an identifier that does not exist and gets
   * a `404` — not a job they are told they may not see, which would itself confirm it exists.
   *
   * @param jobId Derived job identifier.
   * @returns The translated status, or `undefined` when no such instance exists.
   */
  async status(jobId: string): Promise<MediaJobStatus | undefined> {
    const instance = await this.#instance(jobId);
    if (instance === undefined) {
      return undefined;
    }

    const status = await instance.status();

    return {
      state: mediaJobStateFromWorkflow(status.status),
      ...(status.output === undefined ? {} : { output: status.output }),
      ...(status.error === undefined ? {} : { error: status.error.message })
    };
  }

  /**
   * Terminates an instance.
   *
   * @param jobId Derived job identifier.
   * @returns `true` when an instance was found and terminated.
   */
  async cancel(jobId: string): Promise<boolean> {
    const instance = await this.#instance(jobId);
    if (instance === undefined) {
      return false;
    }

    await instance.terminate();
    return true;
  }

  /**
   * Looks up an instance, treating "not found" as absence rather than as an error.
   *
   * The binding throws when an instance does not exist, which would otherwise turn an ordinary
   * "this run is not yours" into a `500`. Narrowing it to `undefined` here keeps that distinction
   * where it belongs.
   *
   * @param jobId Derived job identifier.
   * @returns The instance, or `undefined` when it does not exist.
   */
  async #instance(jobId: string): Promise<WorkflowInstance | undefined> {
    try {
      return await this.#workflow.get(jobId);
    } catch {
      // Deliberately swallowed, and the one place in this demo where that is correct: the binding
      // uses an exception to signal absence, and absence is an expected, meaningful outcome here
      // rather than a fault. Nothing diagnostic is lost — the caller reports a `404`, which is the
      // whole of what there is to say.
      return undefined;
    }
  }
}
