/**
 * @file How tool activity is described in the transcript. The property worth asserting is what the
 *   line does _not_ say: the phrasing comes from the tool name alone, so an activity line can never
 *   leak a record the caller may not see or echo stored content back into the page.
 */

import { describe, expect, it } from 'vitest';
import {
  describePendingWrite,
  describeToolActivity,
  recordPath
} from '../../src/client/services/chat-transcript.ts';
import { TOOL_NAMES } from '../../src/shared/agent/catalogue.ts';

describe('tool activity lines', () => {
  it('describes every catalogue tool in both tenses', () => {
    for (const name of TOOL_NAMES) {
      expect(describeToolActivity(name, false), name).not.toBe('Working in the CRM');
      expect(describeToolActivity(name, true), name).not.toBe('Used the CRM');
    }
  });

  it('reads as present tense while running and past tense when done', () => {
    expect(describeToolActivity('get_contact', false)).toBe('Reading a contact');
    expect(describeToolActivity('get_contact', true)).toBe('Read a contact');
  });

  it('falls back to a generic line for a tool it has no phrase for', () => {
    // A tool name is a protocol identifier, not prose, so showing it to a reader would be worse than
    // a generic sentence.
    expect(describeToolActivity('future_tool', true)).toBe('Used the CRM');
    expect(describeToolActivity('future_tool', false)).toBe('Working in the CRM');
  });

  it('names a pending write in the present tense for its approval card', () => {
    expect(describePendingWrite('create_note')).toBe('Writing a note');
    expect(describePendingWrite('convert_deal')).toBe('Converting a deal');
  });
});

describe('record paths', () => {
  it('matches the SPA’s own routes, including the irregular company plural', () => {
    const id = '00000000-0000-4000-8000-000000000001';

    expect(recordPath('contact', id)).toBe(`/contacts/${id}`);
    expect(recordPath('company', id)).toBe(`/companies/${id}`);
    expect(recordPath('deal', id)).toBe(`/deals/${id}`);
    expect(recordPath('project', id)).toBe(`/projects/${id}`);
    expect(recordPath('note', id)).toBe(`/notes/${id}`);
  });
});
