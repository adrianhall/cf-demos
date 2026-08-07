import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs a lifecycle command with its normal operator-visible output. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

/** Reads a scalar Terraform output without printing it or any credential material. */
async function terraformOutput(name) {
  const { stdout } = await execFileAsync("terraform", ["-chdir=infra", "output", "-raw", name]);
  return stdout.trim();
}

/** Starts one fixed fixture through the only allowed POST endpoint. */
async function start(baseUrl, fixture) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixture }),
    });
    if (response.status === 202) {
      const body = await response.json();
      if (typeof body.id !== "string") {
        throw new Error("POST /jobs did not return a job ID");
      }
      return body.id;
    }
    if (response.status !== 404 || attempt === 14) {
      throw new Error(`POST /jobs returned ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("POST /jobs readiness retries exhausted");
}

/** Polls only GET /jobs/:id until D1 and Durable Object report the required terminal state. */
async function waitForTerminal(baseUrl, id, expectedStatus) {
  const observed = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${baseUrl}/jobs/${id}`);
    if (response.status !== 200) {
      if (response.status === 500 && attempt < 15) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new Error(`GET /jobs/:id returned ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    const d1Status = body?.job?.status;
    const notificationStatus = body?.notification?.status;
    observed.push({ d1Status, notificationStatus });
    if (d1Status === expectedStatus && notificationStatus === expectedStatus) {
      return { id, expectedStatus, observed, final: body };
    }
    if ((d1Status === "ready" || d1Status === "failed") && d1Status !== expectedStatus) {
      throw new Error(`job ${id} ended as ${d1Status}: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`job ${id} did not reach ${expectedStatus} in D1 and Durable Object; last=${JSON.stringify(observed.at(-1))}`);
}

/** Deploys, migrates, probes exactly two fixed fixtures, and tears down in all outcomes. */
async function main() {
  const result = { startedAt: new Date().toISOString(), success: false, jobs: [], failure: null, teardownExitCode: null };
  try {
    await run("npm", ["run", "deploy"]);
    await run("npm", ["run", "db:migrate:remote"]);
    const hostname = await terraformOutput("worker_hostname");
    const baseUrl = `https://${hostname}`;
    const successfulId = await start(baseUrl, "successful");
    result.jobs.push(await waitForTerminal(baseUrl, successfulId, "ready"));
    const invalidId = await start(baseUrl, "invalid");
    result.jobs.push(await waitForTerminal(baseUrl, invalidId, "failed"));
    result.success = true;
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeFile("run-results.json", `${JSON.stringify(result, null, 2)}\n`);
    try {
      await run("npm", ["run", "teardown"]);
      result.teardownExitCode = 0;
    } catch (error) {
      result.teardownExitCode = 1;
      result.failure ??= error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
    await writeFile("run-results.json", `${JSON.stringify(result, null, 2)}\n`);
  }
}

await main();
