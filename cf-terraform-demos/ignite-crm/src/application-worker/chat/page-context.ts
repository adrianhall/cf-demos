/**
 * @file Reading the panel's optional page-context hint out of a chat request body. Its own module
 *   because it is pure and client-facing: the body is whatever the browser sent, and this is where
 *   it stops being untrusted. Keeping it out of `./chat-agent.ts` means it is tested as a function
 *   rather than through a running Durable Object.
 */

import * as v from 'valibot';
import { ChatPageContextSchema, type ChatPageContext } from '../../shared/api/chat.ts';

/**
 * Read the optional page-context hint out of a chat request body.
 *
 * The body is client-controlled, so it is parsed with the strict shared schema and discarded
 * entirely when it does not match: an unparseable hint becomes "no hint", never a prompt fragment a
 * client chose.
 *
 * @param body Custom body fields from the chat request, if any.
 * @returns The validated page context, or `undefined` when absent or invalid.
 */
export function readPageContext(
  body: Record<string, unknown> | undefined
): ChatPageContext | undefined {
  const candidate = body?.pageContext;
  if (candidate === undefined) {
    return undefined;
  }
  const parsed = v.safeParse(ChatPageContextSchema, candidate);
  return parsed.success ? parsed.output : undefined;
}
