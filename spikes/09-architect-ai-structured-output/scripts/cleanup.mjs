#!/usr/bin/env node
import { spawn } from "node:child_process";

/** Runs a lifecycle command without printing or reading environment values. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const worker = await run("npx", ["wrangler", "delete", "--force"]);
const terraform = await run("terraform", ["-chdir=infra", "destroy", "-auto-approve"]);
console.log(JSON.stringify({ workerDeleteExitCode: worker, accessDestroyExitCode: terraform }));
process.exitCode = worker === 0 && terraform === 0 ? 0 : 1;
