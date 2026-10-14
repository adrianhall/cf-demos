/**
 * @file Safe, actionable text for chat transport and model failures. The AI Gateway is deliberately
 *   allowed to refuse a model call: its rolling request limit and daily spend cap stop one busy
 *   installation from turning the assistant into an unbounded bill. The provider's exact error
 *   shape is not a public contract, though, so the browser classifies only the stable signals a
 *   gateway refusal exposes (HTTP 402/429 and bounded-limit wording). Everything else stays
 *   generic: provider details can include internal URLs, model identifiers, or implementation text
 *   and do not belong in the panel.
 */

/**
 * Text the panel can safely display for a chat failure.
 */
export interface ChatFailurePresentation {
  /**
   * The complete, user-facing message.
   */
  readonly message: string;
  /**
   * Whether the failure is a Gateway limit rather than an unavailable connection. The UI does not
   * automatically retry either: a replay could repeat an approval continuation, so recovery is
   * always a new user-initiated turn.
   */
  readonly limited: boolean;
  /**
   * Whether the failure means the account's Workers AI billing or entitlement needs attention.
   */
  readonly billing: boolean;
}

/**
 * Safe message for a temporary Gateway limit.
 */
const LIMITED: ChatFailurePresentation = {
  message: 'The assistant has reached its temporary usage limit. Try again shortly.',
  limited: true,
  billing: false
};

/**
 * Safe message for a Workers AI entitlement or billing failure.
 */
const BILLING: ChatFailurePresentation = {
  message:
    'The assistant is unavailable because Workers AI billing needs attention. CRM data and actions are unaffected.',
  limited: false,
  billing: true
};

/**
 * Safe message for any other failure.
 */
const UNAVAILABLE: ChatFailurePresentation = {
  message: 'The assistant is unavailable right now. Try again in a moment.',
  limited: false,
  billing: false
};

/**
 * Present an error from the chat transport or model without exposing provider internals.
 *
 * @param error The caught error. It may be an `Error`, an HTTP-shaped object from a provider, or an
 *   arbitrary thrown value.
 * @returns A bounded, user-safe presentation.
 */
export function presentChatFailure(error: unknown): ChatFailurePresentation {
  if (hasStatus(error, 402)) {
    return BILLING;
  }
  if (hasStatus(error, 402)) {
    return BILLING;
  }
  if (hasStatus(error, 429)) {
    return LIMITED;
  }
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (
    /payment\s+(?:defaulted|required)|billing|insufficient\s+funds|credit\s+balance/iu.test(text)
  ) {
    return BILLING;
  }
  return /(?:rate|usage|spend|quota).{0,40}(?:limit|exceed)|(?:limit|exceed).{0,40}(?:rate|usage|spend|quota)/iu.test(
    text
  )
    ? LIMITED
    : UNAVAILABLE;
}

/**
 * Whether an unknown error has the supplied HTTP status.
 *
 * @param error The caught value.
 * @param status The status to match.
 * @returns `true` when the value has that numeric status.
 */
function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { status?: unknown; statusCode?: unknown; cause?: unknown };
  return (
    candidate.status === status
    || candidate.statusCode === status
    || hasStatus(candidate.cause, status)
  );
}
