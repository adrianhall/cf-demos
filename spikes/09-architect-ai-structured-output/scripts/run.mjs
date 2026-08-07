#!/usr/bin/env node
import { spawn } from "node:child_process";

/** Runs one lifecycle command and returns its process status. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

let status = 1;
try {
  for (const [command, args] of [
    ["npm", ["run", "provision"]],
    ["node", ["-e", "setTimeout(() => process.exit(0), 15000)"]],
    ["npm", ["run", "deploy"]],
    ["npm", ["run", "probe"]]
  ]) {
    if (await run(command, args)) throw new Error("lifecycle-step-failed");
  }
  status = 0;
} finally {
  const cleanup = await run("npm", ["run", "cleanup"]);
  if (cleanup !== 0) status = 1;
}
process.exitCode = status;
