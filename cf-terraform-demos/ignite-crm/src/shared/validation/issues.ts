/**
 * @file Convert Valibot issues into per-field messages, identically in every tier.
 */

import * as v from 'valibot';

/**
 * Collapse Valibot issues into one message per dotted field path.
 *
 * @param issues Issues from a failed parse.
 * @returns Messages keyed by field path; root-level issues use the key `_`.
 */
export function issueFields(issues: readonly v.BaseIssue<unknown>[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = v.getDotPath(issue) ?? '_';
    fields[path] ??= issue.message;
  }
  return fields;
}
