/**
 * @file Prompt assembly: the system prompt carries the identity and capability header, the
 *   installation context, and the fixed stage names — and **no customer data**. The last claim is
 *   the one worth guarding, so it is asserted against seeded-looking record content directly
 *   (`specs/ignite-crm/05-ai-features.md` §7.1).
 */

import { describe, expect, it } from 'vitest';
import { buildChatSystemPrompt } from '../../../src/application-worker/chat/prompt.ts';
import { DEFAULT_CONFIGURATION } from '../../../src/configuration.ts';
import type { Session } from '../../../src/shared/api/session.ts';

/**
 * A sales user's session.
 */
const session: Session = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'sales@example.com',
    displayName: 'Sam Sales'
  },
  roles: [{ id: 'sales', label: 'Sales representative' }],
  permissions: ['crm.read', 'crm.write', 'report.read']
};

/**
 * Build a prompt with the common inputs.
 *
 * @param overrides Fields to replace.
 * @returns The prompt text.
 */
function prompt(overrides: Partial<Parameters<typeof buildChatSystemPrompt>[0]> = {}): string {
  return buildChatSystemPrompt({
    session,
    configuration: DEFAULT_CONFIGURATION,
    today: 'Wednesday 14 October 2026',
    stageNames: ['Qualifying', 'Proposal', 'Closing'],
    ...overrides
  });
}

describe('chat system prompt', () => {
  it('states who the caller is, what they may do, and how to format answers', () => {
    const text = prompt();

    expect(text).toContain('Sam Sales');
    expect(text).toContain('Sales representative');
    expect(text).toContain('crm.write');
    expect(text).toContain('Wednesday 14 October 2026');
    expect(text).toContain(DEFAULT_CONFIGURATION.timezone);
    expect(text).toContain(DEFAULT_CONFIGURATION.currencyCode);
  });

  it('names the fixed stages so the model cannot invent one', () => {
    expect(prompt()).toContain('Qualifying → Proposal → Closing');
    expect(prompt()).toContain('Never invent a stage name.');
  });

  it('survives a pipeline it could not read without dropping the rule', () => {
    const text = prompt({ stageNames: [] });

    expect(text).toContain('unavailable this turn');
    expect(text).toContain('Never invent a stage name.');
  });

  it('requires tool-grounded answers and approval-gated changes', () => {
    const text = prompt();

    expect(text).toContain('Answer only from tool results.');
    expect(text).toContain('Call a tool before making any factual claim');
    expect(text).toContain('shown to the user for approval');
  });

  it('asks for record links so a named record can be opened', () => {
    const text = prompt();

    expect(text).toContain('/contacts/<id>');
    expect(text).toContain('/companies/<id>');
  });

  it('passes a page-context hint through as a hint, with its identifier', () => {
    const text = prompt({
      pageContext: { route: 'contact', id: '00000000-0000-4000-8000-0000000000b1' }
    });

    expect(text).toContain('looking at the contact with id 00000000-0000-4000-8000-0000000000b1');
    expect(text).toContain('read it with a tool before describing it');
  });

  it('contains no customer data: every record claim must come from a tool call', () => {
    const text = prompt();

    // Nothing resembling a CRM record may appear in the prompt. Grounding is by tool calls over the
    // live RPC contract, so a prompt that carried records would be a second, unauthorised copy of
    // the CRM (§3.3). Stage names and the currency symbol are installation configuration, not
    // records, and are expected to be present.
    for (const leak of ['Northwind', 'Analytical Engines', 'ada@example.com', 'Renewal']) {
      expect(text).not.toContain(leak);
    }
    // The caller's own e-mail is identity, not CRM content, and the display name is enough to
    // address them — so it is not in the prompt either.
    expect(text).not.toContain('sales@example.com');
  });
});
