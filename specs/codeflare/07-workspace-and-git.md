# 07 — Workspace and git

## 1. Storage strategy

Artifacts is the **working git store**. GitHub and GitLab are **explicit publish targets**. This was
a product decision, not an implementation detail.

```text
External GitHub/GitLab remote
        │ import (one time / refresh)                         publish (human only)
        ▼                                                               ▲
┌────────────────────────────────────────────────────────────────────────────────┐
│ Artifacts project repo: main + codeflare/session-a + codeflare/session-b + ...          │
│ - durable git history, native branches, push events                              │
│ - agents commit/push here                                                        │
└───────────────┬────────────────────────────┬────────────────────────────────────┘
                │ clone session branch       │ clone separate branch
                ▼                            ▼
         session A container          session B container
         /workspace                   /workspace
```

Why this is the right default:

- Work remains in the team's Cloudflare account during the agent loop.
- A session can push frequently without external API limits or accidental external publication.
- Artifacts tokens are repo-scoped and short-lived.
- Artifacts push events can trigger CI/review automation.
- Publishing becomes an explicit, auditable human decision.

## 2. Project creation flows

### A. Public HTTPS import

1. User enters `https://github.com/owner/repo.git` or GitLab equivalent.
2. Domain validation accepts only configured provider hosts.
3. The Worker invokes the Artifacts import control-plane API/binding.
4. Artifacts creates the project repo, imports `main`, returns remote and default branch.
5. Project detection reads tree metadata and proposes a `Toolchain`.

### B. Private HTTPS import

Same flow, but the Worker holds the provider token. The import operation must be implemented with
the documented credential-safe pattern — either an authenticated Worker control-plane import or a
temporary gateway. The user-provided URL must never contain username/password/token material.

The import credential is scoped read-only to exactly the selected repository, time-limited, and
stored as a `secretRef`. It is not persisted in D1.

### C. Empty project or template fork

- Empty: `env.ARTIFACTS.create(projectRepoName)`, initial README and `.gitignore` committed by a
  controlled bootstrap process.
- Template: `env.ARTIFACTS.get(templateRepo).fork(projectRepoName, { defaultBranchOnly: true })`.

Templates are reviewed baseline repositories. Do not copy their files through the Worker one at a
time; fork preserves history and is both safer and faster.

## 3. Session creation and clone

A session is a branch and a container. These operations need an idempotent saga because branch
creation, D1 row insertion, container startup, and clone can each fail independently.

### Creation saga

1. Domain service validates the task and authorizes project membership.
2. Insert `sessions` row as `creating`, generate server-side `sessionId` and branch
   `codeflare/<sessionId>`.
3. Ask the Artifacts adapter to create that branch from the selected base ref.
4. Create/obtain `SessionDO` by `projectId:sessionId`.
5. Start the container and install the egress handlers.
6. Mint a **read/write repo-scoped, short-lived** Artifacts token appropriate to the session branch.
7. Clone the session branch into `/workspace` using a header:

   ```sh
   git -c http.extraHeader="Authorization: Bearer $TOKEN" \
     clone --branch "$BRANCH" "$ARTIFACTS_REMOTE" /workspace
   ```

   The header must be process-local and not persisted to `.git/config`.
8. Configure git identity for the agent:

   ```text
   user.name=Codeflare Agent
   user.email=codeflare-agent@<team-domain>
   ```

9. Set `ready`, persist/emit the transition.

### Recovery

Every saga step is repeatable. On a retry:

- A pre-existing D1 row with the same idempotency key returns the original session.
- Existing branch is verified to point at the expected base; it is not overwritten.
- A running container is reused.
- A pre-existing clone is verified with `git rev-parse --is-inside-work-tree`; it is not recloned.
- Any failure sets `failed` with a remediation problem; it does not delete the branch automatically.

## 4. Commit and internal push

At the end of a successful editing turn, the agent follows this controlled sequence:

1. `git status --porcelain=v2` identifies change state.
2. Agent either commits deliberate changes or reports why it left a dirty tree. Auto-committing every
   partial edit at every tool call is forbidden.
3. Commit message must follow `<type>: <summary>` and include trailers:

   ```text
   Codeflare-Session: <session-id>
   Codeflare-Requested-By: <access-email>
   Codeflare-Turn: <turn-id>
   ```

4. Push only the session branch to Artifacts.
5. Record commit SHA in the event stream and D1 projection.

The `GitRepository` domain port does not expose arbitrary `push(remote, refspec)`. It exposes
purpose-specific operations:

```ts
pushSessionBranch(session: Session): Promise<CommitRef>;
requestMerge(project: Project, session: Session): Promise<MergeRequest>;
publishBranch(request: PublishRequest): Promise<PublishResult>;
```

That design prevents an agent tool from accidentally acquiring publishing capability.

## 5. Diffs

The diff view compares:

```sh
git diff --find-renames --binary=false <baseBranch>...<sessionBranch>
```

- Text files use unified diff, syntax highlighting, and per-file navigation.
- Renames are recognised.
- Binary changes show metadata, not a content dump.
- Large diffs are paginated and full raw patches are stored in R2 for download.
- A diff is always produced from Artifacts’ pushed branch, not the possibly-uncommitted container
  filesystem, so reviewer and merge queue see the same source.

## 6. Merge queue

`ProjectDO` serialises the queue. It is the only component allowed to integrate a session branch
into `main` (or another configured base branch).

### Algorithm

```text
enqueue(session, base)
  → validate session belongs to project, branch is pushed, caller is authorised
  → append MergeRequest(status=queued) in ProjectDO SQLite
  → if no active merge: process next

processNext()
  → mark one request merging
  → create ephemeral integration worktree/container from latest target branch
  → fetch target and source from Artifacts
  → git merge --no-ff source
  → if conflict: collect conflict files/hunks; abort merge; mark conflicted
  → if success: run configured quick checks (M2); commit generated merge
  → push target branch to Artifacts atomically/with lease
  → mark merged with SHA; notify originating session and project clients
  → process next
```

### Rules

- Only one `merging` request exists per project. The DO's single-threaded execution is the lock.
- The base branch is refetched immediately before merge. No stale optimistic merge.
- Conflicts are not auto-resolved in M2. They become a structured `ConflictFile[]` and may be
  handed to the originating session as a new task (FR-GIT-080).
- A failed quick check rejects the merge and retains both branches. It never pushes an unverified
  merge commit.
- The integration worktree/container is ephemeral and has no user terminal or preview.
- Use a `--force-with-lease` equivalent / compare-and-swap ref update to detect unexpected external
  modification even though ProjectDO serialises Codeflare's own requests.

## 7. Publishing externally

Publishing is a user-clicked control-plane action, not a tool exposed to an agent.

### Common validation

Before either protocol:

1. Validate requester membership and role.
2. Validate selected remote belongs to the project.
3. Validate ref against the remote's `allowedRefs` glob list.
4. Verify the source commit exists in Artifacts and is reachable from the requested branch.
5. Create an audit event with no secret material.
6. Run the operation in a dedicated ephemeral publish environment, not the session container.

### HTTPS publishing

The publish environment runs `git push` but has no static credential. Its outbound handler:

- allows only the configured provider hostname;
- permits only the required smart-HTTP paths (`info/refs`, `git-receive-pack`);
- injects the GitHub/GitLab token from Secrets Store;
- denies all other methods and paths;
- checks HTTPS before attaching a header.

The provider token can be repository-scoped/deploy-key scoped where the provider supports it. It is
never put in a remote URL.

### SSH publishing

The SSH implementation has stricter requirements because `git` needs private-key material.

```text
Worker → start ephemeral PublishDO container → write key (0600) + pinned known_hosts
       → GIT_SSH_COMMAND="ssh -i /run/codeflare/key -o IdentitiesOnly=yes
           -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/codeflare/known_hosts"
       → git push git@host:owner/repo.git <ref>
       → shred/unlink key → destroy container
```

- Private key: Secrets Store only, read immediately before push.
- Known host entry: stored separately by `hostKeyRef`; key fingerprint shown to an admin at remote
  configuration time.
- `StrictHostKeyChecking=no` is prohibited in source review and CI lint.
- Egress permits the configured host only. Because SSH is not HTTP/HTTPS, the dedicated publisher
  needs carefully constrained network capability; it must never be granted to session containers.
- The publisher is destroyed on all paths with `finally` semantics.

### Publish result

The API returns a provider URL to the pushed branch where one can be derived:

| Provider | HTTPS push URL example |
| -------- | ---------------------- |
| GitHub   | `https://github.com/owner/repo/tree/codeflare/session-id` |
| GitLab   | `https://gitlab.com/namespace/project/-/tree/codeflare/session-id` |

M3 may offer an “open pull request” link, but Codeflare does not create PRs in v1.

## 8. Artifacts CI integration

Artifacts emits `cf.artifacts.repo.pushed`. A later package wires it to a Cloudflare Workflow and
`@cloudflare/ci`.

Recommended job shape:

```ts
const dependencies = await ci.runner({
  name: 'install',
  command: toolchain.installCommand,
  cache: { inputs: ['package.json', 'pnpm-lock.yaml'] },
});

await Promise.all([
  dependencies.runner({ name: 'lint', command: 'pnpm lint' }),
  dependencies.runner({ name: 'test', command: toolchain.testCommand }),
  dependencies.runner({ name: 'build', command: toolchain.buildCommand }),
]);
```

- CI runs on each agent push but uses a debouncer: do not schedule five CI jobs for five commits in
  30 seconds.
- Dependency cache keys include the lockfile.
- CI output is stored in R2 and its summary is appended as a session event.
- Deployment credentials, if CI ever gains them, are restricted to a final deployment step only.

## 9. ArtifactFS decision

Do not use ArtifactFS in M1. A regular clone is simpler and sufficient for ordinary web apps.

Revisit only if metrics show clone time makes NFR-PERF-020 unachievable for large repos. If adopted:

- ArtifactFS requires FUSE and a repo token.
- It starts blobless and hydrates files on demand, making initial tree availability faster.
- `node_modules` and heavy extraction remain poor fits for FUSE; use local container disk for them.
- Its authenticated remote must still not end up in the repo's `.git/config`.

## 10. Cleanup and retention

| Object                  | Normal retention                    | Cleanup path                                      |
| ----------------------- | ----------------------------------- | ------------------------------------------------- |
| Active session branch   | Until archived/deleted              | User archives/deletes; project reaper handles stale. |
| Archived session branch | Project-configured, default 90 days | Scheduled reaper, after warning owner.           |
| Snapshot                | Cloudflare 30 days, refreshed restore | Scheduled reaper removes stale reference/metadata. |
| Session Artifacts repo  | Project lifetime                    | Project delete deletes it.                        |
| Publish container       | One operation                       | Destroyed in `finally`, immediately after push.   |
| CI logs / diff blobs    | 30 days default                     | R2 lifecycle rule.                                |

Deleting a project is a saga: block new sessions, archive/live-stop existing sessions, delete
preview maps and Access entries, delete the Artifacts repository, then delete D1 records. Re-running
it after any failure must converge safely.
