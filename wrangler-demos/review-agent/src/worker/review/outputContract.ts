/**
 * The machine-parseable output contract every reviewer persona's system prompt ends with
 * (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured Findings": "Every persona's
 * system prompt ends with an explicit instruction to reply with prose first ... and then exactly
 * one fenced `json` code block..."). Shared verbatim across all four personas so
 * `./schema.ts`'s `parseFencedFindings()` only ever has to handle one contract shape.
 */
const OUTPUT_CONTRACT = `
After your prose analysis, end your entire reply with exactly one fenced code block, tagged
\`json\`, containing a JSON array of every finding you have (an empty array \`[]\` if you found
none). Each array element MUST match this exact shape:

{
  "findingRef": string,      // e.g. "ARCH-001" -- unique within YOUR OWN output only
  "severity": "critical" | "high" | "medium" | "low",
  "category": string,        // a short label for the kind of issue, e.g. "Repository pattern"
  "filePath": string | null, // repository-relative path, or null if not file-specific
  "lineNumber": number | null,
  "finding": string,         // what you found, concrete and specific
  "recommendation": string   // what to do about it
}

Rules:
- The fenced \`json\` block MUST be the last thing in your reply -- nothing after the closing
  fence.
- Do not manufacture findings to have something to report. If you found nothing, prose can say so
  briefly and the array MUST be \`[]\`.
- Do not include comments, trailing commas, or any text inside the fenced block other than the
  JSON array itself.
`;

/**
 * Append the shared output contract to one persona's condensed review instructions, producing
 * the final system prompt passed to `generateText()` (`./runReviewer.ts`).
 *
 * @param personaPrompt The persona-specific instructions (`./personas/*.ts`).
 * @returns The complete system prompt.
 */
export function withOutputContract(personaPrompt: string): string {
  return `${personaPrompt.trim()}\n${OUTPUT_CONTRACT}`;
}
