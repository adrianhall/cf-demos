/**
 * @file Builds the custom metadata attached to every AI Gateway request. Split out from the
 *   inference client so it can be unit-tested directly, without a binding. The metadata contract is
 *   the part of this demo most likely to be quietly broken by a later change — a new panel that
 *   forgets the email, or a well-meaning "just pass the request body through" — so it is worth
 *   isolating and asserting on its own.
 */

import type { TaskId } from '../../../tasks';
import type { VerifiedActor } from '../../application/ports/inference-port';

/**
 * Custom metadata recorded on an AI Gateway log.
 *
 * AI Gateway accepts strings, numbers, and booleans. Every field here is chosen to be useful for
 * filtering in the dashboard and safe to retain indefinitely.
 *
 * Declared as a type alias rather than an interface so it remains assignable to the binding's
 * `Record<string, string | number | boolean | null | bigint>` metadata parameter: an interface has
 * no implicit index signature and would need a cast at the call site, which is exactly the kind of
 * cast that later hides a genuine mismatch.
 */
export type GatewayMetadata = {
  /**
   * Panel the request came from, so dashboard analytics can be grouped by capability.
   */
  task: TaskId;
  /**
   * Opaque run identifier, correlating the several gateway calls of one user action.
   */
  runId: string;
  /**
   * Verified email of the signed-in user.
   *
   * This demo deliberately records an identifying field, which is a departure from the "log nothing
   * personal" default and therefore a decision rather than an oversight. A shared playground where
   * anyone in the team may sign in and spend real inference credit is only governable if a charge
   * can be traced to the person who caused it. The UI says so plainly before the first request, and
   * the value is the only personal field recorded: no prompt, no upload, no output, and no file
   * name accompanies it.
   */
  user: string;
  /**
   * Reviewed contract version of the model descriptor used, so a log can be interpreted against the
   * request shape that actually produced it.
   */
  contractVersion: number;
};

/**
 * Builds the gateway metadata for one inference request.
 *
 * The actor is a required parameter and is read only from the verified Access identity. A caller
 * cannot pass an email taken from a header or body, because no overload accepts one: the only value
 * available at the call site is the one `currentIdentity()` produced. An attacker-supplied `user`
 * field in a request body is therefore not "ignored" by a filter that someone might later remove —
 * it has nowhere to go in the first place.
 *
 * @param task Panel making the request.
 * @param runId Opaque run identifier correlating the calls of one user action.
 * @param actor Verified Access identity on whose behalf the call is made.
 * @param contractVersion Reviewed contract version of the model descriptor in use.
 * @returns Metadata ready to pass as the gateway `metadata` option.
 * @throws {Error} When the actor carries no email. That means the Access middleware did not run, or
 *   ran and produced an unusable identity; either way the correct response is to fail the request
 *   rather than send an unattributable one to a paid provider.
 */
export function buildGatewayMetadata(
  task: TaskId,
  runId: string,
  actor: VerifiedActor,
  contractVersion: number
): GatewayMetadata {
  const email = actor.email.trim();
  if (email === '') {
    throw new Error(
      'Refusing to send an inference request with no verified user: AI Gateway metadata must '
        + 'attribute every request to the signed-in identity.'
    );
  }

  return { task, runId, user: email, contractVersion };
}
