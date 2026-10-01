/**
 * @file Prepared Chat prompts. Each one exists to demonstrate something specific about the panel
 *   rather than to be impressive: a visitor with an empty text box and no idea what to type learns
 *   nothing, and "write me a poem" teaches nothing about gateways or cost.
 */

/**
 * One prepared prompt.
 */
export interface ChatExample {
  /**
   * Stable identifier, used as a list key and a test hook.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * Prompt text loaded into the editor.
   */
  prompt: string;
  /**
   * What this example is here to show, surfaced as the button's tooltip so the choice is not
   * arbitrary.
   */
  teaches: string;
}

/**
 * Prepared prompts, in button order.
 */
export const CHAT_EXAMPLES: readonly ChatExample[] = [
  {
    id: 'cache',
    label: 'Repeatable question',
    prompt: 'In one sentence, what does an AI gateway do?',
    teaches:
      'Deterministic and short. Ask it twice to see the gateway serve the second request from '
      + 'cache, at no new cost.'
  },
  {
    id: 'long-output',
    label: 'Long answer',
    prompt:
      'Explain how server-sent events differ from WebSockets, covering direction, reconnection, '
      + 'and when each is the better choice.',
    teaches:
      'Generates many output tokens, so streaming and the output half of the bill are both '
      + 'clearly visible.'
  },
  {
    id: 'tokens',
    label: 'Token-heavy input',
    prompt:
      'Summarise this in one line: 2026-04-01T09:15:00Z WARN cache_miss key=u_8831 region=iad '
      + 'latency_ms=412 retries=3',
    teaches:
      'Identifiers, timestamps, and numbers tokenize far less efficiently than prose. Hand it to '
      + 'View Tokens to see why.'
  },
  {
    id: 'reasoning',
    label: 'Short reasoning',
    prompt:
      'A request takes 120 ms at the edge and 480 ms at the origin. Cache hit rate is 70%. What '
      + 'is the average latency? Show your working.',
    teaches:
      'Compare the two models on the same question: the larger one costs more per token and '
      + 'is not always better value.'
  }
];
