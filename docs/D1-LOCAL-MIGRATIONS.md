# Applying D1 migrations locally with the `cf` CLI

Findings from validating `cf d1 migrations apply --local` for this demo, recorded because three of
its behaviours are surprising and one of them contradicts the CLI's own `--help` output.

Verified against `cf@1.0.0-beta.5`, `@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd`, Node
v26.10.0, pnpm 12.6.0, macOS (arm64).

## Verdict

**Works, with caveats.** Local migrations apply cleanly and idempotently, and `cf dev` sees the
resulting schema — including when migrations are applied to a completely cold state **before
`cf dev` has ever been run**. Nothing here blocked the demo. But the working invocation is not the
obvious one, and the three caveats below have to be respected or the command silently does nothing
useful.

## Working command

```bash
cf d1 migrations apply <DATABASE_UUID> --local --persist-to .cloudflare/state
```

In this demo that is wrapped by the shared [`scripts/d1-migrate.ts`](../../scripts/d1-migrate.ts),
which resolves the UUID from Terraform outputs:

```jsonc
{
  "start": "run-s migrate:local start:dev",
  "start:dev": "cf dev --persist-to .cloudflare/state",
  "migrate:local": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/local-outputs.json --local",
  "migrate:remote": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/outputs.json"
}
```

A wrapper script is needed rather than a plain npm script because the positional argument is a
database **UUID**, which is not known until Terraform has created the database. The script reads it
from the same Terraform outputs file that `cloudflare.config.ts` binds, so the migrated database and
the bound database are provably the same one.

## Caveat 1 — it requires a database ID, never a name

```console
$ cf d1 migrations apply todo-db --local
┌ Error
│ Expected a D1 database ID, but received <database>="todo-db". Database
│ names and binding names are not accepted.
└
```

The `--help` text describes the positional as `database  D1 database ID`, which is accurate, but it
is easy to assume a name or binding name works since `wrangler` accepted a binding name here. It
does not.

**Consequence for the demo:** the local D1 binding in `cloudflare.config.ts` is pinned by `id` to a
fixed placeholder UUID, not just by `name`:

```ts
DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName });
```

The local simulation keys its SQLite file by database ID, so binding the same UUID that
`migrate:local` passes is what makes `cf dev` read the migrated schema. Binding only `name` would
produce a _different_, unmigrated database and every query would fail on a missing table.

## Caveat 2 — the default `--persist-to` location is not what `--help` says

`cf --help` documents:

```text
--persist-to  Directory holding local persisted state (default: ~/.config/cloudflare/state)
```

The actual default on macOS is `~/Library/Preferences/cloudflare/state`.
`~/.config/cloudflare/state` was never created:

```console
$ cf d1 migrations apply 00000000-0000-4000-8000-000000000001 --local
$ find ~/.config/cloudflare/state -name '*.sqlite'        # nothing
$ find ~/Library/Preferences/cloudflare/state -path '*d1*' -name '*.sqlite'
/Users/ahall/Library/Preferences/cloudflare/state/v3/d1/miniflare-D1DatabaseObject/3720...sqlite
```

This is a documentation bug rather than a functional one — omitting the flag still works, because
both the migration and `cf dev` resolve the same default. But it puts local database state in a
per-user directory shared across every project on the machine.

**Consequence for the demo:** both `migrate:local` and `cf dev` pass
`--persist-to .cloudflare/state` explicitly, so state stays inside the demo directory (already
gitignored), resetting the database is just `rm -rf .cloudflare/state`, and two demos cannot collide
if they ever share a placeholder UUID.

## Caveat 3 — "no pending migrations" and "wrong database" look identical

A run with nothing to do prints an empty array and exits `0`:

```console
$ cf d1 migrations apply <uuid> --local --persist-to .cloudflare/state
[]
```

That is correct idempotent behaviour — but it is also exactly what a run against the _wrong_
database ID prints, since that database has no applied-migrations table and no migrations are
considered pending for it. There is no output distinguishing "already up to date" from "you just
migrated nothing".

When migrations _are_ applied the output is explicit:

```console
? About to apply 1 migration(s)
Your database may not be available to serve requests during the migration, continue?
  Using fallback value in non-interactive context: yes
[
  {
    "name": "0001_create_todos.sql",
    "status": "✅"
  }
]
```

**Consequence for the demo:** the outcome is verified by asserting on the schema rather than
trusting the exit code. The integration suite builds the schema from the same migration files and
fails if they are wrong, and the confirmation prompt auto-answers `yes` when stdin is not a TTY, so
no extra flag is required for CI.

## Sequencing: migrations before the first `cf dev`

This was the main open question, since it determines whether `pnpm start` can be a single command.
It works. On a wiped state directory, with `cf dev` never having run:

```console
$ rm -rf .cloudflare/state
$ cf d1 migrations apply 00000000-0000-4000-8000-000000000001 --local --persist-to .cloudflare/state
    "name": "0001_create_todos.sql",
    "status": "✅"
$ find .cloudflare/state -path '*d1*' -name '*.sqlite' ! -name 'metadata*'
.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/3720...sqlite
```

The migration creates the database file itself; it does not depend on `cf dev` having initialized
anything first. Starting `cf dev --persist-to .cloudflare/state` afterwards and querying through a
Worker route confirms it reads that same store:

```console
$ curl http://localhost:5173/tables
{"tables":[{"name":"_cf_METADATA"},{"name":"d1_migrations"},{"name":"sqlite_sequence"},{"name":"todos"}]}
$ curl http://localhost:5173/roundtrip
{"row":{"id":"spike-1","user_id":"user-1","title":"from cf dev","completed":0,...}}
```

So `"start": "run-s migrate:local start:dev"` is safe, and a fresh clone needs only `pnpm start`.

Re-running the migration while `cf dev` is running also succeeded; no lock contention was observed.

## Integration tests use a different mechanism

The CLI is deliberately **not** used for tests. `@cloudflare/vitest-plugin` gives each run its own
isolated, in-memory D1 database that the CLI cannot address. The migrations are read in Node and
applied inside the Workers runtime instead:

```ts
// tests/integration/vitest.config.ts
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, '../../migrations'));
// …passed through miniflare.bindings as TEST_MIGRATIONS
```

```ts
// tests/integration/worker.test.ts
import { applyD1Migrations } from 'cloudflare:test';

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
```

Signature:
`applyD1Migrations(db: D1Database, migrations: D1Migration[], migrationsTableName?: string)`, where
`D1Migration` is `{ name: string; queries: string[] }`.

This means the real migration SQL is exercised by `pnpm test`, so a broken migration fails the test
suite rather than only failing a deploy.

## Remote migrations

The remote database is the default target: omit `--local` and `--persist-to`, reading the live
database ID from Terraform outputs:

```bash
cf d1 migrations apply <DATABASE_UUID>
```

`cf` does **not** support Wrangler's `--remote` flag. The shared migration helper therefore passes
no location flag for remote runs. `migrate:remote` is ordered before the build in `deploy:worker`,
so the schema exists before the new code that depends on it is uploaded. Remote migration was not
exercised against the live account during this investigation.
