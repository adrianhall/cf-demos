import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT_KEYS } from '../../infra/outputs';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Reads a file from the demo.
 *
 * @param relative Repository-relative path within the demo.
 * @returns The file's contents as UTF-8 text.
 * @throws {Error} When the file does not exist, which is itself a meaningful failure here: every
 *   file this suite reads is one the demo cannot function without.
 */
async function readDemoFile(relative: string): Promise<string> {
  return readFile(path.join(demoRoot, relative), 'utf8');
}

describe('Terraform outputs', () => {
  // The chain from Terraform output name to Worker binding has four links — `outputs.tf`,
  // `outputs.ts`, `local-outputs.json`, and `cloudflare.config.ts` — and three of them are
  // strings nobody type-checks. A mismatch surfaces at deploy time as a confusing "missing
  // output" error, so it is cheaper to catch here.
  it('declares every output the TypeScript mirror expects', async () => {
    const outputsTf = await readDemoFile('infra/outputs.tf');
    for (const name of Object.values(OUTPUT_KEYS)) {
      expect(outputsTf).toContain(`output "${name}"`);
    }
  });

  it('documents every declared output', async () => {
    const outputsTf = await readDemoFile('infra/outputs.tf');
    const declared = [...outputsTf.matchAll(/output "([a-z_]+)" \{([\s\S]*?)\n\}/gu)];
    expect(declared.length).toBe(Object.keys(OUTPUT_KEYS).length);
    for (const [, name, body] of declared) {
      expect(body, `output "${name}" needs a description`).toContain('description =');
    }
  });

  it('provides a committed local placeholder for every output', async () => {
    const local = JSON.parse(await readDemoFile('infra/local-outputs.json')) as Record<
      string,
      { value: string }
    >;
    for (const name of Object.values(OUTPUT_KEYS)) {
      expect(local[name]?.value, `local-outputs.json needs ${name}`).toBeTruthy();
    }
  });
});

describe('AI Gateway infrastructure', () => {
  // A `default` gateway is created implicitly on first use, shared with everything else in the
  // account, and cannot be destroyed by this demo's teardown. Owning a named one is what makes the
  // gateway's configuration reviewable and its lifecycle complete.
  it('declares a named gateway rather than relying on the implicit default', async () => {
    const tf = await readDemoFile('infra/playground.tf');
    expect(tf).toMatch(/resource "cloudflare_ai_gateway" "demo"/u);
    expect(tf).toMatch(/id\s*=\s*local\.gateway_id/u);
  });

  // Reading cost back out of the gateway log is the entire reason this demo routes through a
  // gateway. Logging off would leave every cost figure permanently "Unavailable".
  it('collects logs so cost and usage can be read back', async () => {
    expect(await readDemoFile('infra/playground.tf')).toMatch(/collect_logs\s*=\s*true/u);
  });

  // The AI Gateway API fills unset fields server-side, which shows up as perpetual plan drift.
  // Writing each one down also turns the privacy and cost posture into a reviewable decision.
  it.each([
    'cache_ttl',
    'cache_invalidate_on_update',
    'rate_limiting_limit',
    'rate_limiting_interval',
    'rate_limiting_technique',
    'log_management',
    'log_management_strategy',
    'log_classification',
    'logpush',
    'zdr',
    'byok_only',
    'authentication'
  ])('sets %s explicitly', async (field) => {
    expect(await readDemoFile('infra/playground.tf')).toMatch(
      new RegExp(`^\\s*${field}\\s*=`, 'mu')
    );
  });

  // `cf` attaches the AI binding at deploy time, so Terraform cannot infer that the Worker depends
  // on the gateway. Without the explicit edge, `terraform destroy` is free to delete a gateway a
  // live Worker is still sending inference through.
  it('forces the Worker to be destroyed before the gateway it uses', async () => {
    const tf = await readDemoFile('infra/playground.tf');
    const workerBlock = /resource "cloudflare_worker" "demo" \{([\s\S]*?)\n\}/u.exec(tf)?.[1] ?? '';
    expect(workerBlock).toMatch(/depends_on\s*=\s*\[cloudflare_ai_gateway\.demo\]/u);
  });
});

describe('Worker configuration', () => {
  it('binds the gateway identifier, audience, and team domain', async () => {
    const config = await readDemoFile('cloudflare.config.ts');
    expect(config).toMatch(/AI_GATEWAY_ID:\s*bindings\.text\(values\.aiGatewayId\)/u);
    expect(config).toMatch(/ACCESS_AUD:\s*bindings\.text\(values\.accessAud\)/u);
    expect(config).toMatch(
      /CLOUDFLARE_TEAM_DOMAIN:\s*bindings\.text\(values\.cloudflareTeamDomain\)/u
    );
  });

  it('binds Workers AI', async () => {
    expect(await readDemoFile('cloudflare.config.ts')).toMatch(/AI:\s*bindings\.ai\(\)/u);
  });

  // The teardown order is the difference between an account left clean and one left with
  // undeletable resources: Cloudflare refuses to delete a gateway that a deployed Worker is still
  // bound to, so the Worker's code has to go first.
  it('deletes the Worker before destroying infrastructure', async () => {
    const pkg = JSON.parse(await readDemoFile('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.teardown).toBe('run-s teardown:worker teardown:infra');
  });

  it('provisions infrastructure before uploading the Worker', async () => {
    const pkg = JSON.parse(await readDemoFile('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.deploy).toBe('run-s deploy:infra deploy:worker');
  });
});
