import { describe, expect, it } from 'vitest';
import {
  findViolations,
  formatViolations,
  isPermittedVariableDefault,
  shouldScan
} from '../../scripts/naming-contract.ts';

/**
 * @file Proves the naming contract's rules work, independently of the script that walks the
 *   filesystem with them. A contract check that scans a clean repository passes whether its rules
 *   are correct or broken, so "`pnpm check:naming` is green" is not evidence of anything on its
 *   own. These tests supply the known-bad text the repository must never contain, which is the only
 *   way to distinguish a rule that works from a rule that matches nothing. The forbidden strings
 *   are assembled from fragments rather than written out, so this file does not violate the
 *   contract it tests and need an exemption — an exemption being exactly the mechanism a stale
 *   literal would later hide behind.
 */

/**
 * The apex domain, joined from fragments so this file stays clean under its own rule.
 */
const APEX = ['cfapps', 'uk'].join('.');

/**
 * The reference deployment's bare Worker name, joined from fragments for the same reason.
 */
const SOURCE_NAME = ['archi', 'tect'].join('');

/**
 * The reference deployment's hostname.
 */
const SOURCE_HOST = `${SOURCE_NAME}.${APEX}`;

describe('findViolations', () => {
  describe('hard-coded apex domain', () => {
    it('rejects the hostname of the deployment this demo was ported from', () => {
      const violations = findViolations('scripts/teardown.ts', `const host = '${SOURCE_HOST}';`);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe('hard-coded-apex-domain');
      expect(violations[0]?.line).toBe(1);
    });

    // The port's own hostname is just as forbidden, and that is deliberate rather than
    // over-reach: Terraform derives it from the `worker_name` variable and the shared
    // CLOUDFLARE_DOMAIN, so a literal copy here would survive a rename and silently disagree
    // with the infrastructure.
    it("rejects the port's own hostname too, since it is equally derived", () => {
      const violations = findViolations('README.md', `Visit https://cf-architect.${APEX}/ today`);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe('hard-coded-apex-domain');
    });

    it('reports the line each occurrence is on', () => {
      const contents = ['first line', 'second line', `host: ${SOURCE_HOST}`].join('\n');

      expect(findViolations('a.ts', contents)[0]?.line).toBe(3);
    });

    it('reports every occurrence, not only the first', () => {
      const contents = `${SOURCE_HOST}\nand again ${SOURCE_HOST}`;

      expect(findViolations('a.ts', contents)).toHaveLength(2);
    });
  });

  describe('bare worker name', () => {
    it('rejects a delete command naming the reference deployment', () => {
      const violations = findViolations(
        'package.json',
        `"cf workers delete ${SOURCE_NAME} --force"`
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe('bare-worker-name');
    });

    it.each([
      ['a Terraform name assignment', `name = "${SOURCE_NAME}"`],
      ['a TypeScript worker name', `workerName: "${SOURCE_NAME}"`],
      ['a snake_case output value', `worker_name = "${SOURCE_NAME}"`]
    ])('rejects %s', (_label, contents) => {
      expect(findViolations('a.tf', contents)[0]?.rule).toBe('bare-worker-name');
    });

    // The whole point of allowing the bare word elsewhere: it is this demo's own name, and a rule
    // that banned it outright would need exemptions in the package name, every heading and every
    // sentence of prose.
    it.each([
      ['prose', `Architect is a diagram editor for Cloudflare architectures.`],
      ['the package name', `"name": "@cf-demos/${SOURCE_NAME}"`],
      ['a path', `import { App } from './${SOURCE_NAME}/App.tsx';`],
      ["the port's own worker name", `name = "cf-${SOURCE_NAME}"`],
      ['a derived name', 'name = "${local.worker_name}"']
    ])('allows %s', (_label, contents) => {
      expect(findViolations('a.ts', contents)).toEqual([]);
    });
  });

  it('returns nothing for clean content', () => {
    expect(findViolations('a.ts', 'const host = values.hostname;')).toEqual([]);
  });

  // A global regular expression carries `lastIndex` between calls. Sharing one instance across
  // files would make a file's result depend on whichever file was scanned before it, which is
  // the kind of bug that makes a contract pass on a second run.
  it('does not carry regex state between calls', () => {
    const contents = `host: ${SOURCE_HOST}`;

    expect(findViolations('a.ts', contents)).toHaveLength(1);
    expect(findViolations('b.ts', contents)).toHaveLength(1);
  });
});

describe('isPermittedVariableDefault', () => {
  const violation = findViolations('infra/providers.tf', `default = "cf-${SOURCE_HOST}"`)[0];

  it('permits the one hostname variable default in providers.tf', () => {
    expect(violation).toBeDefined();
    expect(isPermittedVariableDefault(violation!, `  default = "cf-${SOURCE_HOST}"`)).toBe(true);
  });

  it.each([
    ['a different file', 'infra/outputs.tf', `default = "cf-${SOURCE_HOST}"`],
    ['a local assignment', 'infra/providers.tf', `hostname = "cf-${SOURCE_HOST}"`],
    ['a comment', 'infra/providers.tf', `# default is cf-${SOURCE_HOST}`]
  ])('does not exempt %s', (_label, file, line) => {
    const finding = findViolations(file, line)[0];

    expect(finding).toBeDefined();
    expect(isPermittedVariableDefault(finding!, line)).toBe(false);
  });
});

describe('shouldScan', () => {
  it.each(['src/worker/index.ts', 'infra/architect.tf', 'README.md', 'migrations/0001_x.sql'])(
    'scans %s',
    (file) => {
      expect(shouldScan(file)).toBe(true);
    }
  );

  it.each([
    'node_modules/pkg/index.ts',
    '.cloudflare/types/index.d.ts',
    'coverage/report.json',
    'infra/.terraform/providers/x.tf',
    'infra/outputs.json'
  ])('skips %s', (file) => {
    expect(shouldScan(file)).toBe(false);
  });

  it('skips a file type it cannot read as text', () => {
    expect(shouldScan('src/client/icons/workers.png')).toBe(false);
  });

  // A prefix match on the ignore list must not exclude a sibling that merely starts with the
  // same characters.
  it('does not skip a path that only shares a prefix with an ignored directory', () => {
    expect(shouldScan('distribution/notes.md')).toBe(true);
  });
});

describe('formatViolations', () => {
  it('returns an empty report when there is nothing to report', () => {
    expect(formatViolations([])).toBe('');
  });

  it('names the file, line, rule and reason so the fix is obvious from the output', () => {
    const report = formatViolations(findViolations('scripts/x.ts', `host = '${SOURCE_HOST}'`));

    expect(report).toContain('scripts/x.ts:1');
    expect(report).toContain('hard-coded-apex-domain');
    expect(report).toContain('Terraform');
  });
});
