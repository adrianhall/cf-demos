import { spawnSync } from "node:child_process";

/** Run a command while retaining its text output for a precise absent-Worker decision. */
function run(command, argumentsList) {
  return spawnSync(command, argumentsList, { encoding: "utf8" });
}

const workerName = process.argv[2];
if (!workerName) {
  throw new Error("Worker name is required.");
}

const deployments = run("wrangler", [
  "deployments",
  "list",
  "--name",
  workerName,
  "--json",
]);
if (deployments.status === 0) {
  const deletion = run("wrangler", ["delete", workerName, "--force"]);
  process.stdout.write(deletion.stdout);
  process.stderr.write(deletion.stderr);
  process.exitCode = deletion.status ?? 1;
} else if (
  /[code: 100(?:07|90)]/u.test(`${deployments.stdout}${deployments.stderr}`)
) {
  // A previous interrupted teardown already removed the deployed service.
  process.stdout.write(
    `Worker ${workerName} is already absent; continuing teardown.\n`,
  );
} else {
  process.stdout.write(deployments.stdout);
  process.stderr.write(deployments.stderr);
  process.exitCode = deployments.status ?? 1;
}
