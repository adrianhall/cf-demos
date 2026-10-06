#!/usr/bin/env node
// Node 26 runs this TypeScript file directly (type syntax is erased at runtime).
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';
import { confirm, input, select } from '@inquirer/prompts';

type CfAccount = { id: string; name: string };
type CfWhoami = { authenticated?: boolean; email?: string; accounts?: CfAccount[] };
type CfZone = { id: string; name: string; account?: CfAccount };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cf = path.join(root, 'node_modules', 'cf', 'bin', 'cf');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCf(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [cf, '--quiet', ...args],
        { cwd: root, env },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
          else resolve({ stdout, stderr });
        }
      );
    });
    return stdout;
  } catch (error) {
    throw new Error(`cf ${args.join(' ')} failed:\n${errorMessage(error)}`);
  }
}

async function cfJson<T>(args: string[], env?: NodeJS.ProcessEnv): Promise<T> {
  const output = await runCf(args, env);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`cf ${args.join(' ')} did not return JSON:\n${output}`);
  }
}

async function selectOne<T extends { id: string; name: string }>(
  message: string,
  values: T[]
): Promise<T> {
  if (values.length === 0) throw new Error(`No choices are available for: ${message}`);
  if (values.length === 1) return values[0];
  const id = await select({
    message,
    choices: values.map((value) => ({ name: value.name, value: value.id }))
  });
  const selected = values.find((value) => value.id === id);
  if (!selected) throw new Error('The selected value was not found.');
  return selected;
}

async function getAuthentication(): Promise<CfWhoami> {
  let whoami: CfWhoami | undefined;
  try {
    whoami = await cfJson<CfWhoami>(['auth', 'whoami']);
  } catch {
    // cf auth whoami exits non-zero when no credential exists.
  }

  if (!whoami?.authenticated) {
    console.log(chalk.yellow('Cloudflare authentication is required. Opening cf login…'));
    // An inherited API token cannot be replaced by cf OAuth login.
    const loginEnv = { ...process.env };
    delete loginEnv.CLOUDFLARE_API_TOKEN;
    await runCf(['auth', 'login'], loginEnv);
    whoami = await cfJson<CfWhoami>(['auth', 'whoami'], loginEnv);
  }
  if (!whoami.authenticated) throw new Error('Cloudflare authentication did not complete.');
  return whoami;
}

async function main(): Promise<void> {
  const program = new Command()
    .name('create-env')
    .description('Create .env credentials for the Cloudflare demos')
    .option('--force', 'replace an existing .env without prompting')
    .parse();
  const options = program.opts<{ force?: boolean }>();

  try {
    await access(cf, constants.X_OK);
  } catch {
    throw new Error('cf is not installed. Run pnpm install before pnpm create-env.');
  }

  try {
    await access(envFile, constants.F_OK);
    if (
      !options.force
      && !(await confirm({ message: '.env already exists. Replace it?', default: false }))
    ) {
      console.log('No changes made.');
      return;
    }
  } catch {
    // The file does not exist.
  }

  console.log(chalk.bold('Cloudflare demo environment setup\n'));
  const whoami = await getAuthentication();
  const zones = await cfJson<CfZone[]>(['zones', 'list']);
  const zone = await selectOne('Choose the domain for the demos:', zones);
  const accounts = whoami.accounts ?? [];
  const account = zone.account ?? (await selectOne('Choose the Cloudflare account:', accounts));
  if (!zone.account && accounts.length > 1) {
    console.log(
      chalk.yellow(
        'The selected zone did not report an owning account; verify the account selection.'
      )
    );
  }

  const adminEmail = await input({
    message: 'Administrator email:',
    default: whoami.email ?? '',
    validate: (value) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? true : 'Enter a valid email address.'
  });

  const organization = await cfJson<{ name?: string }>(['zero-trust', 'organizations', 'list'], {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: account.id
  }).catch(() => ({}));
  const teamDomain = organization.name ?? '';
  if (!teamDomain)
    console.log(
      chalk.yellow('No Zero Trust team domain was found; CLOUDFLARE_TEAM_DOMAIN is blank.')
    );

  let contents = await readFile(envExample, 'utf8');
  const values: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: '<from-dashboard>',
    CLOUDFLARE_ACCOUNT_ID: account.id,
    CLOUDFLARE_DOMAIN: zone.name,
    CLOUDFLARE_ZONE_ID: zone.id,
    CLOUDFLARE_TEAM_DOMAIN: teamDomain,
    ADMIN_EMAIL: adminEmail
  };
  for (const [key, value] of Object.entries(values)) {
    contents = contents.replace(
      new RegExp(`^${key}="[^"]*"$`, 'm'),
      `${key}=${JSON.stringify(value)}`
    );
  }
  const temporary = `${envFile}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, envFile);
  console.log(chalk.green(`\nCreated ${path.relative(root, envFile)} for ${zone.name}.`));
  console.log(chalk.yellow('\nAPI-token setup is still required:'));
  console.log('1. In the Cloudflare dashboard, go to My Profile > API Tokens > Create Token.');
  console.log('2. Create a custom token for the selected account and zone with these permissions:');
  console.log('   • Account: AI Gateway — Edit');
  console.log('   • Account: D1 — Edit');
  console.log('   • Account: Workers AI — Edit');
  console.log('   • Account: Workers KV Storage — Edit');
  console.log('   • Account: Workers Scripts — Edit');
  console.log('   • Account: Workers R2 Storage — Edit');
  console.log('   • Account: Access — Edit');
  console.log('   • Account: Access: Identity Providers — Read');
  console.log('   • Zone: DNS — Edit');
  console.log('3. Copy the token value into CLOUDFLARE_API_TOKEN in .env.');
}

main().catch((error: unknown) => {
  console.error(chalk.red(`\nError: ${errorMessage(error)}`));
  process.exitCode = 1;
});
