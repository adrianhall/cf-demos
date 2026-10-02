/**
 * @file Classification of provider failures into the small set of causes this demo can describe
 *   truthfully, and a marker encoding that survives a Workflow boundary. The second half of that is
 *   the interesting part. Within a request, a failed inference call becomes a `ProblemDetailsError`
 *   carrying a status and visitor-facing text, and the Hono error handler renders it. A Workflow
 *   step cannot do that: a thrown error is recorded on the instance as `{ name, message }` and
 *   nothing else, so a `ProblemDetailsError`'s `problemDetails` payload — the status, the title,
 *   the actionable detail — is **silently dropped** on the way out. The status route then sees a
 *   bare message and has no way to tell "the account is out of credit" from "the provider broke",
 *   which are the two failures a visitor most needs told apart: one is fixed by topping up an
 *   account and the other by trying again. So the cause is classified _before_ it crosses the
 *   boundary and re-thrown carrying a stable marker token. The marker is content-free by
 *   construction — it is one of a fixed set of slugs — so nothing a provider wrote can reach the
 *   browser through it, which is the same guarantee the request path makes by sanitising the
 *   message.
 */

/**
 * Why an inference call failed, in the terms this demo is willing to describe.
 *
 * Deliberately coarse. A visitor can act on exactly two distinctions: whether the account needs
 * credit, and whether retrying could plausibly help. Anything finer would be reporting a provider's
 * internals, which this demo does not do.
 */
export type ProviderFailureReason = 'insufficient-credit' | 'provider-failure';

/**
 * Prefix identifying a message this demo wrote rather than one a provider did.
 *
 * Deliberately unlikely to occur in a provider's own error text. A message that does not carry it
 * is treated as unclassified, which is the safe direction: the visitor gets the generic explanation
 * rather than a guess.
 */
export const FAILURE_MARKER = 'playground-failure:';

/**
 * Reports whether a thrown value is AI Gateway's insufficient-credit condition.
 *
 * Kept here rather than in the inference client because two call sites now need the same answer:
 * the request path, which turns it into a `503`, and the Workflow, which has to record it before
 * the boundary discards the classification. One predicate means the two paths cannot disagree about
 * what counts as a billing failure.
 *
 * @param cause Value thrown by the Workers AI binding.
 * @returns `true` for Gateway error 2021 and its documented equivalents.
 */
export function isInsufficientGatewayCredit(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  // Cloudflare binding errors have exposed this condition in several equivalent forms: Gateway code
  // 2021, "Insufficient AI Gateway credits", and "AI credits required". Match only these stable,
  // content-free billing phrases; never send an arbitrary provider message to the browser.
  if (
    /^2021:\s/u.test(cause.message)
    || /\binsufficient AI (?:Gateway )?credits\b/iu.test(cause.message)
    || /\bAI credits (?:are )?required\b/iu.test(cause.message)
  ) {
    return true;
  }

  return cause.cause instanceof Error && isInsufficientGatewayCredit(cause.cause);
}

/**
 * Classifies a thrown value into a reason this demo can describe.
 *
 * Also recognises a marker this demo wrote earlier, so classifying an already-classified failure is
 * idempotent — which matters because a Workflow step's error passes through more than one layer.
 *
 * @param cause Value thrown by an inference call.
 * @returns The reason; `provider-failure` when nothing more specific is recognised.
 */
export function classifyProviderFailure(cause: unknown): ProviderFailureReason {
  const encoded = cause instanceof Error ? decodeFailureReason(cause.message) : undefined;
  if (encoded !== undefined) {
    return encoded;
  }
  return isInsufficientGatewayCredit(cause) ? 'insufficient-credit' : 'provider-failure';
}

/**
 * Encodes a reason as an error message that survives a Workflow boundary.
 *
 * The result is the whole message, carrying no provider text at all. A Workflow records a thrown
 * error as `{ name, message }`, so this is the only channel through which a classification can
 * reach the status route — and keeping it a fixed slug is what makes using that channel safe.
 *
 * @param reason Reason to encode.
 * @returns The marker message to throw.
 */
export function encodeFailureReason(reason: ProviderFailureReason): string {
  return `${FAILURE_MARKER}${reason}`;
}

/**
 * Reads a reason back out of a recorded error message.
 *
 * @param message Message recorded on a failed Workflow instance.
 * @returns The reason, or `undefined` when the message was not written by this demo — in which case
 *   it is a provider's own text and must not be shown to a visitor.
 */
export function decodeFailureReason(message: string): ProviderFailureReason | undefined {
  if (!message.startsWith(FAILURE_MARKER)) {
    return undefined;
  }

  const slug = message.slice(FAILURE_MARKER.length).trim();
  return slug === 'insufficient-credit' || slug === 'provider-failure' ? slug : undefined;
}
