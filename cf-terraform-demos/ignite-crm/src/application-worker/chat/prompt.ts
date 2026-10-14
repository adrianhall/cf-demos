/**
 * @file Prompt assembly for one CRM chat turn. The prompt deliberately carries **no customer
 *   data**. Grounding is by tool calls over the live RPC contract, not by text pasted into the
 *   system message, so what the assistant can see is exactly what the Data Worker will authorise
 *   for this caller — and the prompt cannot become a second, unauthorised copy of the CRM
 *   (`specs/ignite-crm/05-ai-features.md` §3.3). A unit test asserts that second claim directly.
 *   What it does carry: who the caller is, what they may do, the installation's formats, the fixed
 *   pipeline stage names (so the model cannot invent a stage), the behavioural rules, and — when
 *   the panel sends one — a _hint_ naming the record on screen.
 */

import type { InstallationConfiguration } from '../../configuration.ts';
import type { ChatPageContext } from '../../shared/api/chat.ts';
import type { Session } from '../../shared/api/session.ts';

/**
 * Inputs to {@link buildChatSystemPrompt}.
 */
export interface ChatPromptInputs {
  /**
   * The caller's verified session: display name, roles, and capability hints. Capabilities are
   * re-read every turn, so a revoked role takes effect on the next message.
   */
  readonly session: Session;
  /**
   * Installation display settings (locale, time zone, currency).
   */
  readonly configuration: InstallationConfiguration;
  /**
   * Today's date, already formatted in the installation's time zone and locale.
   */
  readonly today: string;
  /**
   * The fixed pipeline stage names, in pipeline order.
   */
  readonly stageNames: readonly string[];
  /**
   * The record the user is looking at, when the panel sent one.
   */
  readonly pageContext?: ChatPageContext;
}

/**
 * Build the system prompt for one turn.
 *
 * @param inputs Identity, capabilities, installation context, stage names, and optional page
 *   context.
 * @returns The system prompt: identity and capability header, installation context, behavioural
 *   rules, and the page-context hint. Never any customer record content.
 */
export function buildChatSystemPrompt(inputs: ChatPromptInputs): string {
  const { session, configuration, today, stageNames, pageContext } = inputs;
  const roles = session.roles.map((role) => role.label).join(', ') || 'no assigned roles';
  const capabilities = session.permissions.join(', ') || 'none';
  const stages = stageNames.length > 0 ? stageNames.join(' → ') : 'unavailable this turn';
  const lines = [
    'You are the Ignite CRM assistant, built into the CRM this user is signed in to.',
    `You are helping ${session.user.displayName} (roles: ${roles}).`,
    `Their capabilities are: ${capabilities}. Never offer to do something they cannot do; say plainly that their access does not allow it.`,
    `Today is ${today} in ${configuration.timezone}. Format dates for ${configuration.locale} and money in ${configuration.currencyCode} (${configuration.currencySymbol}).`,
    `The pipeline stages are fixed, in this order: ${stages}. Never invent a stage name.`,
    'Answer only from tool results. Never guess an identifier, a record, a total, or a stage.',
    'If a tool returns nothing, say so plainly rather than filling the gap. Call a tool before making any factual claim about this CRM.',
    'A deal’s free-text status line is not its won/lost outcome. Notes are separate documents linked to records, not a field on a contact.',
    'Link every record you name, as Markdown, using the application’s own paths: /contacts/<id>, /companies/<id>, /deals/<id>, /projects/<id>, /notes/<id>. The useful next step after you mention a record is opening it.',
    'Never repeat a raw service error and never speculate about a record you could not read.',
    'Every change you propose is shown to the user for approval before it happens, so describe exactly what you are about to change.'
  ];
  if (pageContext !== undefined) {
    // A hint, not an authorisation: the tool call it leads to is checked by the Data Worker exactly
    // as any other, and the identifier is a validated UUID rather than free text.
    lines.push(
      `The user is currently looking at the ${pageContext.route} with id ${pageContext.id}. Treat "this" in their question as that record, and read it with a tool before describing it.`
    );
  }
  return lines.join('\n');
}
