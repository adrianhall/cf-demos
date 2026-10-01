/**
 * @file Prepared inputs for the View Tokens panel. Each example is chosen to make one specific,
 *   counter-intuitive property of tokenization visible in a single click. A blank box teaches
 *   nothing to a visitor who does not already know what to type, and "the quick brown fox" teaches
 *   almost as little.
 */

/**
 * One prepared input.
 */
export interface TokenExample {
  /**
   * Stable identifier, used as the button's key.
   */
  id: string;
  /**
   * Short button label.
   */
  label: string;
  /**
   * What this example demonstrates, shown as the button's description so a visitor chooses
   * deliberately rather than clicking through all of them.
   */
  teaches: string;
  /**
   * The text loaded into the editor.
   */
  text: string;
}

/**
 * The prepared examples, in button order.
 */
export const TOKEN_EXAMPLES: readonly TokenExample[] = [
  {
    id: 'prose',
    label: 'English prose',
    teaches:
      'The familiar case: common words are one token, and the space belongs to the word '
      + 'that follows it.',
    text: 'The gateway records what each request cost, so nobody has to guess.'
  },
  {
    id: 'whitespace',
    label: 'Leading spaces',
    teaches: 'The same word costs different tokens depending on the space before it.',
    text: 'gateway\n gateway\n  gateway\nGateway\nGATEWAY'
  },
  {
    id: 'code',
    label: 'Source code',
    teaches:
      'Indentation and punctuation are expensive, which is why code uses far more tokens '
      + 'per character than prose.',
    text:
      'export function run(input: string): Promise<Result> {\n'
      + '  return client.run({ input, collectLog: true });\n'
      + '}'
  },
  {
    id: 'numbers',
    label: 'Numbers',
    teaches:
      'Long numbers are split into arbitrary chunks, which is part of why models struggle '
      + 'with arithmetic.',
    text: '1 12 123 1234 12345 123456 1234567\n3.14159265358979\n2026-10-01'
  },
  {
    id: 'multilingual',
    label: 'Other languages',
    teaches:
      'The same sentence costs many more tokens in some scripts than in English — a real '
      + 'cost difference, not a rounding error.',
    text:
      'Every request is routed through the gateway.\n'
      + 'Chaque requête passe par la passerelle.\n'
      + 'すべてのリクエストはゲートウェイを経由します。\n'
      + 'كل طلب يمر عبر البوابة.'
  },
  {
    id: 'emoji',
    label: 'Emoji',
    teaches: 'One emoji can cost several tokens, and a family emoji costs eleven.',
    text: 'Shipped 🎉 — the whole team 👨‍👩‍👧‍👦 is pleased 🚀'
  }
];
