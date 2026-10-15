# SalesBot failure runbook

## First response

1. Capture the **correlation ID** from the browser problem response, Cloudflare request details, or
   structured Worker log. Do not copy prompts, answers, transcripts, Access tokens, or email
   addresses into tickets.
2. Search structured logs for that ID. Records contain operation names, bounded counts, model IDs,
   queue/job IDs, latency, and safe reason codes only.
3. Confirm the affected route and verified role. An Access failure (401) is distinct from a
   product-scope decision (403/404); do not weaken audience verification to investigate.

## Indexing backlog or dead-letter jobs

- Open **Administration → Index freshness**. Pending work is retryable. Failed jobs exhausted the
  three-attempt budget and require review.
- Verify the FAQ is still the latest active revision; stale jobs are intentionally completed without
  an index call.
- Restore the AI Search dependency, then use **Run index jobs**. The executor is idempotent and
  preserves the existing correlation audit record. Never manually insert an index row or alter a
  retry count.

## AI Gateway/provider errors

- Use the correlation ID and gateway log ID shown only in trusted internal observability tooling.
- Confirm the gateway ID, reviewed model contract, and provider health. The Worker intentionally has
  no direct Workers AI fallback.
- The user-safe RFC 9457 failure must remain content-free. Retry the web question using its normal
  idempotency key behavior; do not replay a prompt through a shell.

## Rate limiting

- Web message writes are limited to 30 verified-identity operations per one-minute window.
- A 429 is expected protection, not an outage. Wait one minute before retrying. Never delete live
  rate-limit rows to bypass a user; investigate automation or an abusive browser first.

## Retention

`retention_configuration` records the approved default: 365 days for conversations and 730 days for
audit records. Any scheduled deletion implementation must be reviewed separately, preserve
legal/incident holds, emit a content-free audit event, and be tested against the configured values.
