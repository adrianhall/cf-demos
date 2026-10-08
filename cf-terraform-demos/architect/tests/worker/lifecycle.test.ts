import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { MCP_GUIDE_ROUTE } from '../../src/mcp-route.ts';

/**
 * @file Asserts the lifecycle contract the family conventions require, and the naming discipline
 *   that keeps this demo away from the deployment it was ported from. These are ordering and
 *   ownership rules, not behaviour: getting them wrong does not fail a unit test, it strands
 *   billable resources in an account or deletes the wrong Worker. The only place they are written
 *   down is `package.json` and the Terraform files, so that is what is asserted.
 */

/**
 * This demo's npm scripts.
 */
const scripts = packageJson.scripts as Record<string, string>;

/**
 * Reads one of this demo's Terraform files.
 *
 * @param name File name within `infra/`.
 * @returns The file's contents.
 */
async function readTerraform(name: string): Promise<string> {
  return readFile(new URL(`../../infra/${name}`, import.meta.url), 'utf8');
}

describe('required scripts', () => {
  it.each(['start', 'check', 'fix', 'deploy', 'teardown', 'test'])('defines %s', (name) => {
    expect(scripts[name]).toBeDefined();
  });

  it('runs infrastructure before code on deploy', () => {
    expect(scripts.deploy).toBe('run-s deploy:infra deploy:worker');
  });

  // The ordering that matters most. Cloudflare refuses to delete a database or namespace that is
  // still bound to a live Worker, so destroying infrastructure first leaves both the Worker and
  // its storage behind — and `terraform destroy` reports success for the parts it managed.
  it('deletes the Worker before destroying infrastructure on teardown', () => {
    const steps = scripts.teardown?.replace('run-s ', '').split(/\s+/u) ?? [];

    expect(steps.indexOf('teardown:worker')).toBeLessThan(steps.indexOf('teardown:infra'));
  });

  it('writes Terraform outputs immediately after applying them', () => {
    expect(scripts['postdeploy:infra:apply']).toContain('terraform -chdir=infra output -json');
    expect(scripts['postdeploy:infra:apply']).toContain('infra/outputs.json');
  });

  it('migrates the remote database before building and uploading the Worker', () => {
    const steps = scripts['deploy:worker']?.replace('run-s ', '').split(/\s+/u) ?? [];

    expect(steps.indexOf('migrate:remote')).toBeLessThan(steps.indexOf('deploy:worker:build'));
    expect(steps.indexOf('deploy:worker:build')).toBeLessThan(
      steps.indexOf('deploy:worker:upload')
    );
  });

  it('applies local migrations before starting the local server', () => {
    const steps = scripts.start?.replace('run-s ', '').split(/\s+/u) ?? [];

    expect(steps.indexOf('migrate:local')).toBeLessThan(steps.indexOf('start:dev'));
  });

  // Without `--persist-to`, `cf` writes the local D1 simulation to an OS-specific user directory
  // that does not match where `pnpm migrate:local` put the schema, so `cf dev` silently reads an
  // empty database.
  it('pins the local state directory so dev and migrations address the same database', () => {
    expect(scripts['start:dev']).toContain('--persist-to .cloudflare/state');
  });

  it('uses the repository-root migration helper rather than calling the CLI directly', () => {
    expect(scripts['migrate:local']).toContain('../../scripts/d1-migrate.ts');
    expect(scripts['migrate:remote']).toContain('../../scripts/d1-migrate.ts');
  });

  it('runs deploys and teardowns non-interactively', () => {
    expect(scripts['deploy:infra:apply']).toContain('-auto-approve');
    expect(scripts['teardown:infra']).toContain('-auto-approve');
  });

  it('checks everything the conventions require, write-free', () => {
    const check = scripts.check ?? '';

    expect(check).toContain('check:types');
    expect(check).toContain('check:format');
    expect(check).toContain('check:lint');
    expect(check).toContain('check:infra');
    expect(check).toContain('check:infra:fmt');
    expect(scripts['check:format']).toContain('--check');
    expect(scripts['check:infra:fmt']).toContain('-check');
  });

  it('asserts the built-stylesheet contract and the naming contract as part of check', () => {
    expect(scripts.check).toContain('check:css');
    expect(scripts.check).toContain('check:naming');
    // The contract must read build output, not source: the CSS transformation it guards against
    // only happens during a build.
    expect(scripts['check:css']).toContain('build');
  });

  it('resolves the Worker name to delete rather than naming one', () => {
    expect(scripts['teardown:worker']).toBe('node scripts/delete-worker.ts');
  });
});

describe('no Wrangler anywhere', () => {
  // `cf` supersedes Wrangler and this family exists to illustrate the `cf` workflow. A Wrangler
  // dependency or command creeping back in would quietly reintroduce the templating step and the
  // observability-mirroring duplication the typed configuration retires.
  it('declares no Wrangler dependency', () => {
    const dependencies = {
      ...(packageJson.dependencies as Record<string, string>),
      ...(packageJson.devDependencies as Record<string, string>)
    };

    expect(Object.keys(dependencies).filter((name) => name.includes('wrangler'))).toEqual([]);
  });

  it('runs no Wrangler command', () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `${name} must not call Wrangler`).not.toMatch(/\bwrangler\b/u);
    }
  });
});

describe('Terraform ownership', () => {
  it('splits configuration by concern', async () => {
    await expect(readTerraform('providers.tf')).resolves.toContain('required_providers');
    await expect(readTerraform('access.tf')).resolves.toContain(
      'cloudflare_zero_trust_access_application'
    );
    await expect(readTerraform('architect.tf')).resolves.toContain('cloudflare_worker');
    await expect(readTerraform('outputs.tf')).resolves.toContain('output "worker_name"');
  });

  it('reads the repository-root .env rather than a per-demo one', async () => {
    const providers = await readTerraform('providers.tf');

    expect(providers).toContain('${path.module}/../../../.env');
    expect(providers).not.toMatch(/TF_VAR_/u);
  });

  it('pins the current major provider version', async () => {
    expect(await readTerraform('providers.tf')).toMatch(/version\s*=\s*"~>\s*5\./u);
  });

  // Terraform owns infrastructure; `cf` owns code. A `cloudflare_workers_script` resource would
  // put both in charge of the same thing.
  it('never uploads application code', async () => {
    const worker = await readTerraform('architect.tf');

    expect(worker).not.toContain('cloudflare_workers_script');
  });

  describe('the worker_name and hostname variables', () => {
    it('declares both with descriptions', async () => {
      const providers = await readTerraform('providers.tf');

      expect(providers).toMatch(/variable\s+"worker_name"/u);
      expect(providers).toMatch(/variable\s+"hostname"/u);
      expect(providers).toMatch(/variable\s+"worker_name"[\s\S]*?description\s*=/u);
      expect(providers).toMatch(/variable\s+"hostname"[\s\S]*?description\s*=/u);
    });

    it('derives every nameable local from them', async () => {
      const providers = await readTerraform('providers.tf');

      for (const name of ['worker_name', 'database_name', 'shares_kv_name', 'hostname']) {
        expect(providers, `local.${name} must derive from a variable`).toMatch(
          new RegExp(String.raw`${name}\s*=\s*[^\n]*var\.`, 'u')
        );
      }
    });

    it('names no resource with a literal instead of a local', async () => {
      const worker = await readTerraform('architect.tf');

      expect(worker).toContain('name       = local.worker_name');
      expect(worker).toContain('hostname   = local.hostname');
    });

    it('derives every Access domain and destination from the hostname local', async () => {
      const access = await readTerraform('access.tf');
      const uris = [...access.matchAll(/uri\s*=\s*"([^"]+)"/gu)].map((match) => match[1] as string);
      const domains = [...access.matchAll(/domain\s*=\s*([^\n]+)/gu)].map((match) =>
        (match[1] as string).trim()
      );

      expect(uris.length).toBeGreaterThan(0);
      for (const uri of uris) {
        expect(uri, 'every Access destination must derive from local.hostname').toContain(
          `\${local.hostname}`
        );
      }
      for (const domain of domains) {
        expect(domain, 'every Access domain must derive from local.hostname').toContain(
          'local.hostname'
        );
      }
    });
  });

  describe('teardown safety', () => {
    // The bindings are attached by `cf`, so Terraform cannot infer that the Worker depends on the
    // database and namespace. Without the explicit edge it may try to delete storage that is
    // still bound, which Cloudflare refuses.
    it('makes the Worker depend on every binding resource it uses', async () => {
      const worker = await readTerraform('architect.tf');
      const dependsOn =
        /resource "cloudflare_worker" "demo"[\s\S]*?depends_on = \[([\s\S]*?)\]/u.exec(worker)?.[1]
        ?? '';

      expect(dependsOn).toContain('cloudflare_d1_database.demo');
      expect(dependsOn).toContain('cloudflare_workers_kv_namespace.shares');
    });

    // Cloudflare rejects a custom domain on a Worker with zero deployments, and Terraform never
    // uploads the real code, so a placeholder deployment must exist first.
    it('bootstraps a deployment before attaching the custom hostname', async () => {
      const worker = await readTerraform('architect.tf');

      expect(worker).toContain('cloudflare_worker_version" "bootstrap');
      expect(worker).toMatch(
        /resource "cloudflare_workers_custom_domain"[\s\S]*?depends_on = \[cloudflare_workers_deployment\.bootstrap\]/u
      );
    });

    // Every real deploy supersedes the bootstrap version. Without `ignore_changes`, Terraform
    // would see that as drift and revert the deployment to the 503 placeholder on the next apply.
    it('ignores all changes to the bootstrap resources', async () => {
      const worker = await readTerraform('architect.tf');
      const bootstrapBlocks =
        worker.match(/resource "cloudflare_worker[^"]*" "bootstrap"[\s\S]*?\n\}/gu) ?? [];

      expect(bootstrapBlocks.length).toBeGreaterThanOrEqual(2);
      for (const block of bootstrapBlocks) {
        expect(block).toContain('ignore_changes = all');
      }
    });
  });

  describe('Access posture', () => {
    it('keeps the public bypass and the authenticated application distinct', async () => {
      const access = await readTerraform('access.tf');

      expect(access).toMatch(/decision\s*=\s*"bypass"/u);
      expect(access).toMatch(/decision\s*=\s*"allow"/u);
    });

    // The mechanism that keeps anonymous sharing working: the resolver is simply absent from the
    // authenticated application's destinations, so it falls through to the public one. An
    // `/api/*` wildcard here would take it private without touching a line of application code.
    it('never covers the whole API with a wildcard destination', async () => {
      const access = await readTerraform('access.tf');
      const uris = [...access.matchAll(/uri\s*=\s*"([^"]+)"/gu)].map((match) => match[1] as string);

      expect(uris).not.toContain(`\${local.hostname}/api/*`);
      expect(uris.some((uri) => uri.includes('/api/shares'))).toBe(false);
      // A liveness probe that requires identity cannot answer whether the deployment is serving
      // traffic when authentication itself is the thing that is broken. Like the anonymous share
      // resolver, it deliberately falls through to the hostname-wide bypass application.
      expect(uris.some((uri) => uri.includes('/api/health'))).toBe(false);
    });

    // Admin authorization is an application decision re-checked on every request, not an Access
    // policy. Encoding it here would mean the Worker could not verify it as defence in depth.
    it('encodes no administrator identity in a policy', async () => {
      const access = await readTerraform('access.tf');

      expect(access).not.toContain('admin_email');
    });

    // The public guide page's posture, asserted at the layer that would actually break it.
    //
    // `src/access-policies.ts` cannot catch this and neither can the Workers-runtime suite: in
    // production a page is served straight from the asset store behind the real Access
    // application, so the Worker never sees the request at all. The only thing standing between
    // the guide page and a login screen is its absence from the destination globs below.
    //
    // An Access path wildcard matches a *partial segment* — Cloudflare documents
    // `example.com/foo*` as covering `example.com/food` — so `${hostname}/mcp*` would capture a
    // guide page at `/mcp-guide`. The Worker's own `/^\/mcp(?:\/|$)/u` policy would not, so the
    // two layers would disagree, every offline test would pass, and only the deployment would
    // redirect. This expands each destination glob the same way Access does and requires that
    // none of them claims the guide page.
    it('leaves the public MCP guide page outside every authenticated destination', async () => {
      const access = await readTerraform('access.tf');
      const paths = [...access.matchAll(/uri\s*=\s*"\$\{local\.hostname\}([^"]*)"/gu)].map(
        (match) => match[1] as string
      );

      expect(paths).toContain('/mcp*');
      for (const path of paths) {
        const pattern = new RegExp(
          `^${path
            .split('*')
            .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
            .join('.*')}$`,
          'u'
        );

        expect(
          pattern.test(MCP_GUIDE_ROUTE),
          `the "${path}" Access destination would capture the public guide page at `
            + `${MCP_GUIDE_ROUTE}, putting a login in front of the page that explains how to sign in`
        ).toBe(false);
      }
    });
  });
});
