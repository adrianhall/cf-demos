/**
 * @file Turns the AI SDK's message parts into what the transcript actually shows. Two jobs, both
 *   pure, so both are unit-tested without a DOM:
 *
 *   1. **Tool activity as a sentence.** A tool call renders as one compact line — "Looked up a
 *      customer" — rather than as JSON. The phrasing comes from the tool name alone, never from the
 *      tool's arguments or result, so the activity line cannot leak a record the user may not see
 *      or echo stored content back into the page.
 *   2. **Record links.** The assistant names records in Markdown; the renderer already turns
 *      same-origin links into anchors, so the model is given the SPA's own paths to use. This
 *      module is the one place those paths are built, so a route rename is a single edit.
 */

import { CHAT_CONTEXT_ROUTES, type ChatContextRoute } from '../../shared/api/chat.ts';

/**
 * How a tool call is described in the transcript, keyed by tool name.
 *
 * Present-tense while running, past-tense when done, and no record content in either: the whole
 * point of the line is to show _that_ the assistant looked something up, not to restate it.
 */
const TOOL_ACTIVITY: Readonly<Record<string, { running: string; done: string }>> = {
  whoami: { running: 'Checking your access', done: 'Checked your access' },
  search_customers: { running: 'Searching customers', done: 'Searched customers' },
  get_contact: { running: 'Reading a contact', done: 'Read a contact' },
  get_company: { running: 'Reading a company', done: 'Read a company' },
  list_deals: { running: 'Listing deals', done: 'Listed deals' },
  get_deal: { running: 'Reading a deal', done: 'Read a deal' },
  action_stream: { running: 'Reading your follow-ups', done: 'Read your follow-ups' },
  pipeline_summary: { running: 'Totalling the pipeline', done: 'Totalled the pipeline' },
  quarterly_pipeline: { running: 'Reading the quarter', done: 'Read the quarter' },
  list_projects: { running: 'Listing projects', done: 'Listed projects' },
  get_project: { running: 'Reading a project', done: 'Read a project' },
  my_work: { running: 'Reading your tasks', done: 'Read your tasks' },
  search_notes: { running: 'Searching notes', done: 'Searched notes' },
  get_note: { running: 'Reading a note', done: 'Read a note' },
  delivery_report: { running: 'Totalling delivery', done: 'Totalled delivery' },
  create_contact: { running: 'Creating a contact', done: 'Created a contact' },
  update_contact: { running: 'Updating a contact', done: 'Updated a contact' },
  update_company: { running: 'Updating a company', done: 'Updated a company' },
  create_deal: { running: 'Creating a deal', done: 'Created a deal' },
  update_deal: { running: 'Updating a deal', done: 'Updated a deal' },
  set_deal_outcome: { running: 'Setting a deal outcome', done: 'Set a deal outcome' },
  log_activity: { running: 'Logging activity', done: 'Logged activity' },
  set_next_action: { running: 'Setting a next action', done: 'Set a next action' },
  complete_next_action: { running: 'Completing a next action', done: 'Completed a next action' },
  convert_deal: { running: 'Converting a deal', done: 'Converted a deal' },
  create_task: { running: 'Creating a task', done: 'Created a task' },
  update_task: { running: 'Updating a task', done: 'Updated a task' },
  create_note: { running: 'Writing a note', done: 'Wrote a note' },
  update_note: { running: 'Updating a note', done: 'Updated a note' }
};

/**
 * Describe a tool call for the transcript.
 *
 * @param toolName The tool's protocol name.
 * @param finished Whether the call has produced a result.
 * @returns A short sentence with no record content. An unrecognised name — a tool added to the
 *   catalogue without a phrase here — falls back to a generic line rather than showing its
 *   identifier, because the name itself is not written for a reader.
 */
export function describeToolActivity(toolName: string, finished: boolean): string {
  const phrase = TOOL_ACTIVITY[toolName];
  if (phrase === undefined) {
    return finished ? 'Used the CRM' : 'Working in the CRM';
  }
  return finished ? phrase.done : phrase.running;
}

/**
 * Describe a pending write for its approval card.
 *
 * @param toolName The mutating tool's protocol name.
 * @returns A sentence naming what is about to happen, in the present tense.
 */
export function describePendingWrite(toolName: string): string {
  const phrase = TOOL_ACTIVITY[toolName];
  return phrase === undefined ? 'Change something in the CRM' : phrase.running;
}

/**
 * The SPA path for a record, so the assistant's Markdown can link into the app.
 *
 * @param route The record kind.
 * @param id The record identifier.
 * @returns The same-origin path, which the Markdown renderer turns into an in-app link.
 */
export function recordPath(route: ChatContextRoute, id: string): string {
  return `/${route === 'company' ? 'companies' : `${route}s`}/${id}`;
}

/**
 * Every record path pattern the assistant may produce, for the prompt and for tests that assert the
 * panel links rather than prints identifiers.
 */
export const RECORD_ROUTES: readonly ChatContextRoute[] = CHAT_CONTEXT_ROUTES;
