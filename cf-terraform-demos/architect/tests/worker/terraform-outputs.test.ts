import { describe, expect, it } from 'vitest';
import localOutputs from '../../infra/local-outputs.json' with { type: 'json' };
import { OUTPUT_KEYS, type TerraformOutputs } from '../../infra/outputs.ts';

/**
 * @file Proves the three descriptions of this demo's Terraform outputs agree. The same nine values
 *   are declared in `infra/outputs.tf`, typed in `infra/outputs.ts`, and stubbed in
 *   `infra/local-outputs.json`. Nothing but a test connects them: a mismatch produces a runtime
 *   failure at `cf dev` startup or, worse, at deploy time — well after the edit that caused it.
 */

/**
 * `infra/outputs.tf`, read as text. Parsing HCL properly would need a dependency for one assertion;
 * the output names are unambiguous in the source.
 */
const outputsTf = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../../infra/outputs.tf', import.meta.url), 'utf8')
);

/**
 * Output names declared in `infra/outputs.tf`.
 */
const declaredOutputs = [...outputsTf.matchAll(/^output\s+"([a-z0-9_]+)"/gmu)].map(
  (match) => match[1] as string
);

describe('Terraform output contract', () => {
  it('declares every output the TypeScript mirror expects', () => {
    expect([...declaredOutputs].sort()).toEqual([...Object.values(OUTPUT_KEYS)].sort());
  });

  it('stubs every declared output in the committed local fixture', () => {
    expect(Object.keys(localOutputs).sort()).toEqual([...declaredOutputs].sort());
  });

  // A scalar-only rule, from the family conventions: a structured output cannot be read by
  // `terraform output -raw`, which is how `pnpm teardown` resolves the Worker name.
  it('gives every output a non-empty string value in the local fixture', () => {
    for (const [name, output] of Object.entries(localOutputs)) {
      expect(output.type, `${name} must be a scalar string output`).toBe('string');
      expect(output.value.length, `${name} must not be empty`).toBeGreaterThan(0);
    }
  });

  // Every output is consumed by something — `cloudflare.config.ts`, a lifecycle script or a
  // migration command — and a description is what tells the next reader which.
  it('documents every output', () => {
    const described = [
      ...outputsTf.matchAll(/^output\s+"([a-z0-9_]+)"\s*\{\s*\n\s*description\s*=/gmu)
    ].map((match) => match[1] as string);

    expect([...described].sort()).toEqual([...declaredOutputs].sort());
  });

  it('exposes no secret through an output', () => {
    expect(outputsTf).not.toMatch(/api_token/u);
    expect(Object.keys(localOutputs)).not.toContain('cloudflare_api_token');
  });
});

describe('local development fixture', () => {
  /**
   * The fixture's values, flattened into the shape `cloudflare.config.ts` consumes.
   */
  const values = Object.fromEntries(
    Object.entries(OUTPUT_KEYS).map(([key, name]) => [
      key,
      (localOutputs as Record<string, { value: string }>)[name]?.value
    ])
  ) as TerraformOutputs;

  // `cf d1 migrations apply` keys the local SQLite simulation by database ID and rejects a name,
  // so the fixture's ID is what makes `pnpm migrate:local` and `cf dev` address the same
  // database. A malformed one fails at `cf dev` startup rather than here.
  it('uses a syntactically valid D1 database ID', () => {
    expect(values.d1DatabaseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    );
  });

  // The Worker validates the `aud` claim against this value. A 64-character hex tag is the shape
  // Access issues, so the placeholder matches it rather than being an arbitrary string.
  it('uses an Access audience of the shape Access actually issues', () => {
    expect(values.accessAud).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('selects development logging by naming a non-production environment', () => {
    expect(values.environment).toBe('development');
  });

  // The fixture is committed, so every value in it is public by definition. A real hostname or a
  // real administrator address would be a small disclosure for no benefit, and a real hostname
  // would additionally let a local misconfiguration point at live infrastructure.
  it('names only non-routable, obviously local placeholders', () => {
    expect(values.hostname.endsWith('.localhost')).toBe(true);
    expect(values.adminEmail.endsWith('@example.com')).toBe(true);
    expect(values.workerName.endsWith('-local')).toBe(true);
  });
});
