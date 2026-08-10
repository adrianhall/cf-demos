import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEMO_OWNED_KEYS,
  quoteValue,
  parseOverrides,
  applyOverrides,
  findPlaceholders,
  findDemoDirs,
  generateForDemo,
  main,
} from "./update-env.mjs";

test("quoteValue wraps and escapes special characters", () => {
  assert.equal(quoteValue("plain"), '"plain"');
  assert.equal(quoteValue('has "quotes"'), '"has \\"quotes\\""');
  assert.equal(quoteValue("back\\slash"), '"back\\\\slash"');
});

test("quoteValue rejects newlines", () => {
  assert.throws(() => quoteValue("line1\nline2"), /newlines/);
});

test("parseOverrides strips demo-owned keys", () => {
  const overrides = parseOverrides('CLOUDFLARE_API_TOKEN="tok"\nDEMO_NAME="root-name"\n');
  assert.equal(overrides.CLOUDFLARE_API_TOKEN, "tok");
  assert.equal("DEMO_NAME" in overrides, false);
  assert.ok(DEMO_OWNED_KEYS.has("DEMO_NAME"));
});

test("applyOverrides preserves comments and unmatched lines verbatim", () => {
  const example = [
    "# Required permissions:",
    "#   Workers Scripts : Edit",
    "",
    'CLOUDFLARE_API_TOKEN="<from-dashboard>"',
    'DEMO_NAME="link"',
    "",
  ].join("\n");

  const { text, declaredKeys, appliedKeys } = applyOverrides(example, {
    CLOUDFLARE_API_TOKEN: "real-token",
  });

  assert.ok(text.includes("# Required permissions:"));
  assert.ok(text.includes("#   Workers Scripts : Edit"));
  assert.ok(text.includes('CLOUDFLARE_API_TOKEN="real-token"'));
  assert.ok(text.includes('DEMO_NAME="link"'), "DEMO_NAME must not be overridden");
  assert.deepEqual([...declaredKeys].sort(), ["CLOUDFLARE_API_TOKEN", "DEMO_NAME"]);
  assert.deepEqual([...appliedKeys], ["CLOUDFLARE_API_TOKEN"]);
});

test("applyOverrides never overrides DEMO_NAME even if root .env supplies it", () => {
  const example = 'DEMO_NAME="link"\n';
  const { text, appliedKeys } = applyOverrides(example, { DEMO_NAME: "should-not-apply" });
  assert.ok(text.includes('DEMO_NAME="link"'));
  assert.equal(appliedKeys.size, 0);
});

test("applyOverrides does not introduce keys the example does not declare", () => {
  const example = 'CLOUDFLARE_API_TOKEN="<from-dashboard>"\n';
  const { text } = applyOverrides(example, {
    CLOUDFLARE_API_TOKEN: "real-token",
    ADMIN_EMAIL: "someone@example.com",
  });
  assert.ok(!text.includes("ADMIN_EMAIL"));
});

test("findPlaceholders reports unfilled <...> values", () => {
  const text = ['CLOUDFLARE_API_TOKEN="<from-dashboard>"', 'DEMO_NAME="link"', 'ADMIN_EMAIL="admin@example.com"'].join(
    "\n",
  );
  assert.deepEqual(findPlaceholders(text), ["CLOUDFLARE_API_TOKEN"]);
});

/**
 * Builds a throwaway `demos/<name>/.env.example` fixture under a temp
 * directory for use by generateForDemo/findDemoDirs tests.
 */
function makeDemoFixture(demosRoot, name, exampleContents) {
  const demoDir = join(demosRoot, name);
  mkdirSync(demoDir, { recursive: true });
  writeFileSync(join(demoDir, ".env.example"), exampleContents);
  return demoDir;
}

test("findDemoDirs discovers only directories with a .env.example", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  makeDemoFixture(root, "alpha", 'DEMO_NAME="alpha"\n');
  mkdirSync(join(root, "no-example"), { recursive: true });

  const found = findDemoDirs(root).map((dir) => dir.split("/").pop());
  assert.deepEqual(found, ["alpha"]);
});

test("generateForDemo writes an overridden .env and reports unsupplied/placeholder keys", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  const demoDir = makeDemoFixture(
    root,
    "widget",
    [
      'CLOUDFLARE_API_TOKEN="<from-dashboard>"',
      'CLOUDFLARE_ACCOUNT_ID="<from-dashboard>"',
      'DEMO_NAME="widget"',
      'ADMIN_EMAIL="admin@example.com"',
      "",
    ].join("\n"),
  );

  const result = generateForDemo(demoDir, { CLOUDFLARE_API_TOKEN: "real-token" });

  assert.equal(result.status, "written");
  assert.deepEqual(result.appliedKeys, ["CLOUDFLARE_API_TOKEN"]);
  assert.deepEqual(result.unsuppliedKeys, ["ADMIN_EMAIL", "CLOUDFLARE_ACCOUNT_ID"]);
  assert.deepEqual(result.placeholders, ["CLOUDFLARE_ACCOUNT_ID"]);

  const written = readFileSync(join(demoDir, ".env"), "utf8");
  assert.ok(written.includes('CLOUDFLARE_API_TOKEN="real-token"'));
  assert.ok(written.includes('DEMO_NAME="widget"'));
});

test("generateForDemo skips an existing .env unless force is set", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  const demoDir = makeDemoFixture(root, "widget", 'CLOUDFLARE_API_TOKEN="<from-dashboard>"\n');
  writeFileSync(join(demoDir, ".env"), 'CLOUDFLARE_API_TOKEN="operator-edited"\n');

  const skipped = generateForDemo(demoDir, { CLOUDFLARE_API_TOKEN: "real-token" });
  assert.equal(skipped.status, "skipped");
  assert.equal(readFileSync(join(demoDir, ".env"), "utf8"), 'CLOUDFLARE_API_TOKEN="operator-edited"\n');

  const forced = generateForDemo(demoDir, { CLOUDFLARE_API_TOKEN: "real-token" }, { force: true });
  assert.equal(forced.status, "written");
  assert.ok(readFileSync(join(demoDir, ".env"), "utf8").includes('CLOUDFLARE_API_TOKEN="real-token"'));
});

test("generateForDemo dry-run reports the plan without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  const demoDir = makeDemoFixture(root, "widget", 'CLOUDFLARE_API_TOKEN="<from-dashboard>"\n');

  const result = generateForDemo(demoDir, { CLOUDFLARE_API_TOKEN: "real-token" }, { dryRun: true });
  assert.equal(result.status, "written");
  assert.equal(existsSync(join(demoDir, ".env")), false);
});

test("main exits non-zero when the repo-root .env is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  const originalError = console.error;
  console.error = () => {};
  try {
    const code = main([], root);
    assert.equal(code, 1);
  } finally {
    console.error = originalError;
  }
});

test("main fans a root .env out to every discovered demo", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-demos-test-"));
  writeFileSync(join(root, ".env"), 'CLOUDFLARE_API_TOKEN="root-token"\nDEMO_NAME="should-not-apply"\n');
  mkdirSync(join(root, "demos"), { recursive: true });
  makeDemoFixture(join(root, "demos"), "alpha", 'CLOUDFLARE_API_TOKEN="<from-dashboard>"\nDEMO_NAME="alpha"\n');
  makeDemoFixture(join(root, "demos"), "beta", 'CLOUDFLARE_API_TOKEN="<from-dashboard>"\nDEMO_NAME="beta"\n');

  const originalLog = console.log;
  console.log = () => {};
  let code;
  try {
    code = main([], root);
  } finally {
    console.log = originalLog;
  }

  assert.equal(code, 0);
  const alpha = readFileSync(join(root, "demos", "alpha", ".env"), "utf8");
  const beta = readFileSync(join(root, "demos", "beta", ".env"), "utf8");
  assert.ok(alpha.includes('CLOUDFLARE_API_TOKEN="root-token"'));
  assert.ok(alpha.includes('DEMO_NAME="alpha"'));
  assert.ok(beta.includes('CLOUDFLARE_API_TOKEN="root-token"'));
  assert.ok(beta.includes('DEMO_NAME="beta"'));
});
