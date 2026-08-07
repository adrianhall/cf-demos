import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

/** Runs a cleanup command without allowing an earlier cleanup failure to skip later cleanup. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => resolve({ command: [command, ...args].join(" "), outcome: "spawn-error", detail: error.message }));
    child.on("close", (code) => resolve({ command: [command, ...args].join(" "), outcome: code === 0 ? "success" : "failed", exitCode: code }));
  });
}

/** Removes Wrangler-managed bindings before Terraform destroys their backing resources. */
async function main() {
  const outcomes = [];
  outcomes.push(await run("npx", ["wrangler", "delete", "--force", "--config", "wrangler.jsonc"]));
  outcomes.push(await run("npx", ["empty-r2-bucket", "-t", "infra", "--env-file", "../../.env", "--yes"]));
  outcomes.push(await run("terraform", ["-chdir=infra", "destroy", "-auto-approve"]));
  await writeFile("teardown-results.json", `${JSON.stringify({ completedAt: new Date().toISOString(), outcomes }, null, 2)}\n`);
  process.exitCode = outcomes.every((outcome) => outcome.outcome === "success") ? 0 : 1;
}

await main();
