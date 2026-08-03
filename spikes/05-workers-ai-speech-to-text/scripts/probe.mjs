#!/usr/bin/env node
/**
 * Drives the deployed spike Worker over its own public (Access-bypassed) hostname, once per
 * fixture/mode combination, and prints each result as JSON (docs/06-AGENTIC-CHAT.md, Phase 0,
 * Spike E). See README.md for how to deploy first.
 *
 * Usage: node scripts/probe.mjs --host <worker-host> [--mode <mode>] [--fixture <name>]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? process.env.SPIKE_HOST;
if (!host) {
  console.error("Usage: node scripts/probe.mjs --host <worker-host> [--mode <mode>] [--fixture <name>]");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(scriptDir, "..", "fixtures");

/**
 * Two versions of the same ~12-second synthesized utterance (macOS `say` piped through
 * `ffmpeg`): one matching a browser `MediaRecorder`'s real default output
 * (`audio/webm;codecs=opus`, mono, 48kHz), one client-side-converted to 16-bit PCM WAV — the
 * two candidates US-4's acceptance criterion (Section 5) asks this spike to choose between.
 */
const FIXTURES = [
  { name: "webm-opus", file: "utterance.webm", contentType: "audio/webm;codecs=opus" },
  { name: "wav", file: "utterance.wav", contentType: "audio/wav" },
];

const MODES = [
  "binding-base64",
  "experimental-transcribe",
  "binding-array",
  "nova3",
  "nova3-raw-bytes",
  "nova3-experimental-transcribe",
];

const fixturesToRun = args.fixture ? FIXTURES.filter((f) => f.name === args.fixture) : FIXTURES;
const modesToRun = args.mode ? [args.mode] : MODES;

for (const fixture of fixturesToRun) {
  const bytes = readFileSync(path.join(fixturesDir, fixture.file));
  for (const mode of modesToRun) {
    const url = `https://${host}/transcribe?mode=${mode}`;
    const wallStart = Date.now();
    let status;
    let body;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": fixture.contentType },
        body: bytes,
      });
      status = res.status;
      body = await res.json();
    } catch (error) {
      body = { error: error instanceof Error ? error.message : String(error) };
    }
    const wallMs = Date.now() - wallStart;
    console.log(
      JSON.stringify(
        { fixture: fixture.name, byteLength: bytes.byteLength, wallMs, status, ...body },
        null,
        2,
      ),
    );
  }
}
