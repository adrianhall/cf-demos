/**
 * @file Audit projection rules: which metadata keys may leave the Data Worker. Pure functions, so
 *   the redaction rule is unit-tested directly. Writers already store only safe metadata (see the
 *   `mutation.audit(...)` calls in each application service, and the note digest in
 *   `../../application/notes/notes-service.ts`). The read side does not rely on that alone: it
 *   passes each event's metadata through {@link AUDIT_METADATA_ALLOWLIST}, so a future writer that
 *   adds a body, status line, or e-mail by mistake is redacted at the boundary instead of
 *   disclosed. Defence in depth, applied where the data leaves.
 */

/**
 * Metadata keys an audit reader may see: identifiers, field names, enumerated statuses, counts,
 * versions, dates, and content digests. The key is only the first gate: string values are checked
 * against each key's vocabulary or format below, so an accidentally reused key cannot leak text.
 */
export const AUDIT_METADATA_ALLOWLIST: ReadonlySet<string> = new Set([
  // Shared change description.
  'fields',
  'version',
  'status',
  // CRM.
  'stage',
  'type',
  'contacts',
  'companyId',
  'dealId',
  'ownerId',
  'amountMinor',
  'dueDate',
  'followUpId',
  'via',
  'viaConversion',
  // Projects.
  'projectId',
  'leadId',
  'priority',
  // Notes: a digest and link ids, never the body.
  'digest',
  'linkCount',
  'linksAdded',
  'linksRemoved',
  'titleChanged',
  // Permissions.
  'role',
  'rolesBefore',
  'rolesAfter',
  'statusBefore',
  'statusAfter'
]);

/**
 * A safe metadata value.
 */
export type AuditValue = string | number | boolean | null;

/**
 * Formats safe to expose in audit metadata. In particular, keys that might otherwise contain
 * arbitrary text (such as `fields`, `status`, or `linksAdded`) are constrained to known
 * vocabularies or identifier lists. A future writer must extend this projection deliberately.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_VALUE = new RegExp(`^${UUID}$`, 'u');
const LINK_LIST = new RegExp(
  `^(?:contact|company|deal|project):${UUID}(?:,(?:contact|company|deal|project):${UUID})*$`,
  'u'
);
const FIELD_LIST =
  /^(?:title|markdown|links|name|description|address|stockSymbol|companiesHouseUrl|primaryContactId|status|stageId|ownerId|amountMinor|statusLine|nextActionText|nextActionDate|expectedCloseDate|leadId|targetDate|assigneeId|dueDate|priority|firstName|lastName|email|phone|jobTitle|companyId)(?:,(?:title|markdown|links|name|description|address|stockSymbol|companiesHouseUrl|primaryContactId|status|stageId|ownerId|amountMinor|statusLine|nextActionText|nextActionDate|expectedCloseDate|leadId|targetDate|assigneeId|dueDate|priority|firstName|lastName|email|phone|jobTitle|companyId))*$/u;
const ROLE_LIST =
  /^(?:owner|manager|sales|delivery|read-only)(?:,(?:owner|manager|sales|delivery|read-only))*$/u;
const ENUM =
  /^(?:active|suspended|pending|won|lost|on_hold|completed|archived|todo|in_progress|in_review|done|no_priority|low|medium|high|urgent|call|meeting|contact|company|deal|project|direct|lead|qualified|proposal|negotiation)$/u;

/**
 * Decide whether a key's value is safe to expose, not just scalar.
 *
 * @param key The allowlisted key.
 * @param value The parsed JSON value.
 * @returns Whether the key and value match their documented format.
 */
function safeValue(key: string, value: unknown): value is AuditValue {
  if (!AUDIT_METADATA_ALLOWLIST.has(key)) {
    return false;
  }
  if (value === null) {
    return true;
  }
  if (typeof value === 'boolean') {
    return ['viaConversion', 'titleChanged'].includes(key);
  }
  if (typeof value === 'number') {
    return (
      Number.isSafeInteger(value)
      && value >= 0
      && ['version', 'contacts', 'amountMinor', 'linkCount'].includes(key)
    );
  }
  if (typeof value !== 'string' || value.length > 1024) {
    return false;
  }
  if (['companyId', 'dealId', 'ownerId', 'followUpId', 'projectId', 'leadId'].includes(key)) {
    return UUID_VALUE.test(value);
  }
  switch (key) {
    case 'digest':
      return /^[0-9a-f]{64}$/u.test(value);
    case 'linksAdded':
    case 'linksRemoved':
      return LINK_LIST.test(value);
    case 'fields':
      return FIELD_LIST.test(value);
    case 'rolesBefore':
    case 'rolesAfter':
    case 'role':
      return ROLE_LIST.test(value);
    case 'status':
    case 'statusBefore':
    case 'statusAfter':
    case 'stage':
    case 'type':
    case 'priority':
    case 'via':
      return ENUM.test(value);
    case 'dueDate':
      return /^\d{4}-\d{2}-\d{2}$/u.test(value);
    default:
      return false;
  }
}

/**
 * Parse stored audit metadata and keep only allowlisted, scalar values.
 *
 * @param json The stored `metadata_json` text.
 * @returns The safe metadata and whether anything was removed. Malformed or non-object JSON is
 *   treated as fully redacted rather than thrown, so one bad row cannot break the trail.
 */
export function redactMetadata(json: string): {
  metadata: Record<string, AuditValue>;
  redacted: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { metadata: {}, redacted: true };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { metadata: {}, redacted: true };
  }
  const metadata: Record<string, AuditValue> = {};
  let redacted = false;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (safeValue(key, value)) {
      metadata[key] = value;
    } else {
      redacted = true;
    }
  }
  return { metadata, redacted };
}
