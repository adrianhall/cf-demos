#!/usr/bin/env node
/**
 * @file Spike F's live probe against the deployed `spike-04-ai-gateway-cost-reconciliation`
 * Worker and the real AI Gateway REST API.
 *
 * This is the actual spike (docs/06-AGENTIC-CHAT.md, Section 8: "Where a spike's only reasonable
 * way to exercise the real platform is a [...] test, that one test is the spike"). It:
 *
 * 1. Calls the deployed Worker's `/call` endpoint, which runs a dynamic-route `env.AI.run()` call
 *    tagged with a fresh UUID as `gateway.metadata.requestId` (Spike B confirmed
 *    `env.AI.aiGatewayLogId` is `null` for a dynamic-route call, so this UUID is the only
 *    correlation key available).
 * 2. Polls `GET /accounts/{account}/ai-gateway/gateways/{gateway}/logs` directly (this repo's own
 *    `.env` `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, per Section 8's "reuse the root .env"
 *    rule) with a `filters=[{"key":"metadata.value","operator":"eq","value":["<uuid>"]}]` query,
 *    sorted `created_at` desc, until the correlated row appears or a timeout is reached —
 *    measuring the exact real-world reconciliation lag Phase 6's `this.schedule()` delay/backoff
 *    must be set from.
 * 3. Once found, calls the Worker's `/log?id=<logId>` endpoint (the binding's documented
 *    `getLog()`, Spike B's already-confirmed shape) to confirm it resolves to the same row the
 *    list already returned.
 * 4. Repeats for several sequential trials (lag statistics) and one concurrent batch (does
 *    firing multiple `env.AI.run()` calls close together within one Worker invocation still let
 *    each call's own log row be told apart afterward, or is serialization required).
 * 5. Confirms `getLog()`'s "not found" signal for a made-up id, re-verifying Spike B's finding.
 *
 * Usage:
 *   node --env-file=../../.env scripts/probe.mjs --host <worker-host> [--trials 5] [--n 5]
 *
 * (`npm run probe` wires the `--env-file` flag in automatically — see package.json.)
 */
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs() {
  const args = { trials: 5, n: 5, maxWaitMs: 90_000, pollIntervalMs: 2_000 };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    const value = process.argv[i + 1];
    args[key] = ["trials", "n", "maxWaitMs", "pollIntervalMs"].includes(key)
      ? Number(value)
      : value;
  }
  return args;
}

const args = parseArgs();
const host = args.host ?? process.env.SPIKE_HOST;
if (!host) {
  console.error("Usage: probe.mjs --host <worker-host> [--trials 5] [--n 5]");
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  console.error(
    "Missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN — run via `npm run probe` " +
      "(wires --env-file=../../.env) or export them yourself.",
  );
  process.exit(1);
}

const GATEWAY_ID = "spike-04-cost-recon";
const WORKER_BASE = `https://${host}`;
const LOGS_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${GATEWAY_ID}/logs`;

/** Calls the deployed Worker's `/call` endpoint for one dynamic-route turn. */
async function callWorker(requestId, business) {
  const url = new URL(`${WORKER_BASE}/call`);
  url.searchParams.set("requestId", requestId);
  if (business) {
    url.searchParams.set("business", business);
  }
  const res = await fetch(url);
  return res.json();
}

/** Calls the deployed Worker's `/call-concurrent` endpoint. */
async function callWorkerConcurrent(n) {
  const url = new URL(`${WORKER_BASE}/call-concurrent`);
  url.searchParams.set("n", String(n));
  const res = await fetch(url);
  return res.json();
}

/** Calls the deployed Worker's `/log?id=` endpoint (the binding's `getLog()`). */
async function getLogViaWorker(logId) {
  const url = new URL(`${WORKER_BASE}/log`);
  url.searchParams.set("id", logId);
  const res = await fetch(url);
  return res.json();
}

/**
 * Queries the real AI Gateway logs-list REST API directly, filtering by an exact `metadata.value`
 * match (REPORT.md Section 3 documents why this — not `metadata.key` paired with it — is the
 * only filter clause that actually narrows to a specific correlation value; the two sub-filters
 * are independently applied existence checks, not a paired key=value match).
 */
async function listLogsByMetadataValue(value, { perPage = 5 } = {}) {
  const filters = JSON.stringify([{ key: "metadata.value", operator: "eq", value: [value] }]);
  const url = new URL(LOGS_URL);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "desc");
  url.searchParams.set("filters", filters);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`logs-list request failed: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

/**
 * Polls `listLogsByMetadataValue` every `pollIntervalMs` until a row appears or `maxWaitMs`
 * elapses. Returns `{ found: true, log, elapsedMs, attempts }` or `{ found: false, elapsedMs,
 * attempts }`.
 */
async function pollForCorrelatedLog(requestId, { maxWaitMs, pollIntervalMs }) {
  const startedAt = Date.now();
  let attempts = 0;
  while (Date.now() - startedAt < maxWaitMs) {
    attempts += 1;
    const rows = await listLogsByMetadataValue(requestId);
    if (rows.length > 0) {
      return { found: true, log: rows[0], elapsedMs: Date.now() - startedAt, attempts };
    }
    await sleep(pollIntervalMs);
  }
  return { found: false, elapsedMs: Date.now() - startedAt, attempts };
}

/** Runs one sequential trial: call, poll for correlation, cross-check via the binding's getLog(). */
async function runSingleTrial(index, { maxWaitMs, pollIntervalMs }) {
  const requestId = crypto.randomUUID();
  const business = index % 2 === 0 ? "leadership" : "field";
  console.log(`\n[trial ${index}] calling with requestId=${requestId} business=${business}`);
  const callResult = await callWorker(requestId, business);
  console.log(`[trial ${index}] call result:`, callResult);

  const pollResult = await pollForCorrelatedLog(requestId, { maxWaitMs, pollIntervalMs });
  if (!pollResult.found) {
    console.log(`[trial ${index}] NOT FOUND after ${pollResult.elapsedMs}ms`);
    return { requestId, callResult, pollResult };
  }
  console.log(
    `[trial ${index}] found after ${pollResult.elapsedMs}ms (${pollResult.attempts} polls):`,
    pollResult.log,
  );

  const viaGetLog = await getLogViaWorker(pollResult.log.id);
  console.log(`[trial ${index}] getLog() cross-check:`, viaGetLog);

  return { requestId, business, callResult, pollResult, viaGetLog };
}

/** Runs the concurrency trial: N calls in flight together inside one Worker invocation. */
async function runConcurrencyTrial(n, { maxWaitMs, pollIntervalMs }) {
  console.log(`\n[concurrent] firing ${n} calls concurrently inside one Worker invocation`);
  const { results } = await callWorkerConcurrent(n);
  console.log("[concurrent] call results:", results);

  const polls = await Promise.all(
    results.map((r) => pollForCorrelatedLog(r.requestId, { maxWaitMs, pollIntervalMs })),
  );
  results.forEach((r, i) => {
    const p = polls[i];
    console.log(
      `[concurrent] slot ${i} requestId=${r.requestId} ->`,
      p.found ? `found log ${p.log.id} after ${p.elapsedMs}ms` : `NOT FOUND after ${p.elapsedMs}ms`,
    );
  });

  const foundLogIds = polls.filter((p) => p.found).map((p) => p.log.id);
  const distinctLogIds = new Set(foundLogIds);
  console.log(
    `[concurrent] ${foundLogIds.length}/${n} correlated; ${distinctLogIds.size} distinct log ids ` +
      "(should equal the found count — any collision means two calls resolved to the same log row)",
  );

  return { results, polls };
}

/** Confirms `getLog()`'s "not found" signal for a made-up id (re-verifying Spike B's finding). */
async function runNotFoundTest() {
  console.log("\n[not-found] calling getLog() with a made-up id");
  const result = await getLogViaWorker("00000000-not-a-real-log-id");
  console.log("[not-found] result:", result);
  return result;
}

async function main() {
  console.log(`Spike F probe — host=${host} gateway=${GATEWAY_ID}`);
  const pollOpts = { maxWaitMs: args.maxWaitMs, pollIntervalMs: args.pollIntervalMs };

  const trials = [];
  for (let i = 1; i <= args.trials; i += 1) {
    // Sequential, not Promise.all: this batch measures single-call reconciliation lag in
    // isolation; the concurrency question is answered separately by runConcurrencyTrial.
    trials.push(await runSingleTrial(i, pollOpts));
  }

  const concurrency = await runConcurrencyTrial(args.n, pollOpts);
  const notFound = await runNotFoundTest();

  const lags = trials.filter((t) => t.pollResult.found).map((t) => t.pollResult.elapsedMs);
  const summary = {
    sequentialTrials: trials.length,
    sequentialFound: lags.length,
    lagMsMin: lags.length ? Math.min(...lags) : null,
    lagMsMax: lags.length ? Math.max(...lags) : null,
    lagMsAvg: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
    concurrencyFound: concurrency.polls.filter((p) => p.found).length,
    concurrencyTotal: concurrency.results.length,
    concurrencyDistinctLogIds: new Set(
      concurrency.polls.filter((p) => p.found).map((p) => p.log.id),
    ).size,
  };

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== FULL RESULTS (for REPORT.md) ===");
  console.log(JSON.stringify({ trials, concurrency, notFound, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
