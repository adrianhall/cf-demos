/**
 * @file The naming contract this demo must satisfy, shared by the `pnpm check:naming` script
 *   (`./check-naming-contract.ts`) and the unit tests that prove the rule itself works
 *   (`../tests/worker/naming-contract.test.ts`).
 *
 *   ## Why this exists
 *
 *   This demo is a port of an implementation that is still deployed, on the same account, under the
 *   shorter name. That deployment is the reference for what "correct" looks like and must keep
 *   running until the port is signed off. A stale literal is therefore not a tidiness problem: `cf
 *   workers delete <literal>` would take the reference deployment down, and a custom hostname
 *   naming it would move live traffic onto half-finished code. The protection is structural. The
 *   Worker name and hostname are Terraform variables (`infra/providers.tf`); every consumer
 *   resolves them from Terraform output; and this contract fails `pnpm check` if either could be
 *   reached from a literal instead.
 *
 *   ## What is deliberately _not_ forbidden
 *
 *   The bare word "architect" is not banned. It is this demo's own name, its package name and the
 *   subject of every sentence in its documentation, so banning it would force a wave of exemptions
 *   that would hollow the rule out. The two rules below instead forbid the things that can actually
 *   resolve to the reference deployment: a hard-coded apex domain, and the bare name in a position
 *   where a tool reads it as a Worker name.
 */

/**
 * A pattern that must not match anything in this demo's committed files.
 */
export interface ForbiddenLiteral {
  /**
   * Short identifier used in test names and failure output.
   */
  id: string;
  /**
   * Regular expression matching the forbidden literal. Carries the global flag so every occurrence
   * in a file is reported rather than only the first.
   */
  pattern: RegExp;
  /**
   * Human-readable explanation of what breaks if the literal is committed, shown in the failure
   * message so the next reader does not have to find this file to understand the rule.
   */
  reason: string;
}

/**
 * Patterns that would let this demo's lifecycle commands or infrastructure reach the deployment it
 * was ported from.
 */
export const FORBIDDEN_LITERALS: ForbiddenLiteral[] = [
  {
    id: 'hard-coded-apex-domain',
    // Assembled rather than written out, because this file would otherwise violate its own rule
    // and need an exemption — and an exemption is exactly the mechanism a stale literal would
    // later hide behind.
    pattern: new RegExp(String.raw`[\w.-]*\.${'cfapps'}\.${'uk'}`, 'giu'),
    reason:
      'the apex domain belongs to the repository-root .env (CLOUDFLARE_DOMAIN), and Terraform '
      + 'derives the hostname from it. A hard-coded host here can name the deployment this demo '
      + 'was ported from, which must keep serving until cutover. Use the Terraform `hostname` '
      + 'output, or a clearly fictional fixture host in a test.'
  },
  {
    id: 'bare-worker-name',
    // Only in a position a tool reads as a Worker name: a `cf workers delete` argument, a
    // Terraform `name =` assignment, or a `workerName`/`worker_name` value. Prose and the package
    // name are untouched.
    pattern: new RegExp(
      String.raw`(?:cf\s+workers\s+delete\s+|(?:worker_?[Nn]ame|name)\s*[:=]\s*["']?)`
        + String.raw`architect(?![\w-])`,
      'gu'
    ),
    reason:
      'this names the Worker of the deployment this demo was ported from. `pnpm teardown` '
      + 'resolves the name from the Terraform `worker_name` output and Terraform derives every '
      + 'resource from the `worker_name` variable, so nothing needs it spelled out.'
  }
];

/**
 * Paths, relative to the demo root, that the contract never reads.
 *
 * Generated, vendored and build-output trees only. No authored file is exempt: an exception for a
 * source file would be an exception for exactly the kind of literal this contract exists to
 * prevent.
 */
export const IGNORED_PATHS = [
  '.cloudflare',
  '.git',
  'coverage',
  'dist',
  'infra/.terraform',
  'infra/outputs.json',
  'node_modules'
];

/**
 * File extensions the contract reads. Everything else — images, archives, lockfiles — is skipped,
 * because a binary scanned as UTF-8 produces noise rather than findings.
 */
export const SCANNED_EXTENSIONS = [
  '.css',
  '.hcl',
  '.html',
  '.json',
  '.jsonc',
  '.md',
  '.sql',
  '.tf',
  '.ts',
  '.tsx'
];

/**
 * One forbidden literal found in a scanned file.
 */
export interface NamingViolation {
  /**
   * Path of the offending file, relative to the demo root.
   */
  file: string;
  /**
   * 1-based line number of the occurrence.
   */
  line: number;
  /**
   * The matched text, preserving the case it was written in.
   */
  match: string;
  /**
   * Identifier of the rule that matched, from {@link ForbiddenLiteral.id}.
   */
  rule: string;
  /**
   * Why the literal is forbidden, copied from {@link ForbiddenLiteral.reason}.
   */
  reason: string;
}

/**
 * Finds every forbidden literal in one file's contents.
 *
 * Exported so the rule can be unit-tested directly against known-good and known-bad text, rather
 * than only observed through the exit code of a script that walks the filesystem.
 *
 * @param file Path reported in any violation, relative to the demo root.
 * @param contents The file's text.
 * @returns Every violation found, ordered by line. Empty when the file is clean.
 */
export function findViolations(file: string, contents: string): NamingViolation[] {
  const violations: NamingViolation[] = [];

  for (const { id, pattern, reason } of FORBIDDEN_LITERALS) {
    // A global regular expression carries mutable `lastIndex` state between calls, so it is
    // re-created per scan rather than shared. Reusing the instance above directly would make a
    // file's result depend on whichever file happened to be scanned before it.
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null = scanner.exec(contents);
    while (match !== null) {
      violations.push({
        file,
        line: contents.slice(0, match.index).split('\n').length,
        match: match[0],
        reason,
        rule: id
      });
      match = scanner.exec(contents);
    }
  }

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * Reports whether a path should be scanned.
 *
 * @param relativePath Path relative to the demo root, using forward slashes.
 * @returns `true` when the path is neither ignored nor of an unscanned type.
 */
export function shouldScan(relativePath: string): boolean {
  if (
    IGNORED_PATHS.some(
      (ignored) => relativePath === ignored || relativePath.startsWith(`${ignored}/`)
    )
  ) {
    return false;
  }
  return SCANNED_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}

/**
 * Reports whether a finding is the Terraform hostname variable default the specification permits.
 *
 * This is intentionally exact: only `infra/providers.tf`, only a `default =` assignment, and only
 * the hostname rule. A hostname in a local, output, comment, script or second Terraform file still
 * fails the contract. The bare Worker-name default is not matched by the scoped rule in the first
 * place because its variable is named `worker_name`, not a tool-facing `name` assignment.
 *
 * @param violation Finding to classify.
 * @param line Complete source line containing the finding.
 * @returns `true` only for the permitted hostname variable default.
 */
export function isPermittedVariableDefault(violation: NamingViolation, line: string): boolean {
  return (
    violation.file === 'infra/providers.tf'
    && violation.rule === 'hard-coded-apex-domain'
    && /^\s*default\s*=\s*"[^"]+"\s*$/u.test(line)
  );
}

/**
 * Renders violations as a human-readable report.
 *
 * @param violations Violations to describe.
 * @returns A multi-line report naming each file, line and reason, or an empty string when there is
 *   nothing to report.
 */
export function formatViolations(violations: NamingViolation[]): string {
  if (violations.length === 0) {
    return '';
  }

  const lines = violations.map(
    ({ file, line, match, rule, reason }) => `  ${file}:${line}  [${rule}] "${match}" — ${reason}`
  );

  return [
    `Naming contract failed: ${violations.length} forbidden literal(s) found.`,
    ...lines,
    '',
    'See infra/providers.tf for the `worker_name` and `hostname` variables these values must be',
    'derived from.'
  ].join('\n');
}
