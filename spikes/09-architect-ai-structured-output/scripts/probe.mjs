#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const hostname = "spike-09-architect-ai-structured-output-20260807.adrian-hall-internal-demo.workers.dev";
const results = [];
for (const fixture of ["small", "medium", "invalid"]) {
  let recorded;
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(`https://${hostname}/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixture })
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { responseKind: "non-json-edge-response" };
      }
      recorded = { fixture, attempt, wallMs: Date.now() - startedAt, status: response.status, workerReached: response.headers.get("x-spike-worker") === "09", body };
      if (recorded.workerReached || response.status !== 404 || attempt === 7) break;
    } catch (error) {
      recorded = { fixture, attempt, wallMs: Date.now() - startedAt, status: 0, failure: error instanceof Error ? error.name : "request-failed" };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  results.push(recorded);
}
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(resolve("artifacts/probe-results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.status !== 200)) process.exitCode = 1;
