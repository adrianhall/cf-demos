# Validating The Collaborative-Editing Implementation (`docs/09C-COLLABORATIVE-EDITING.md`)

This is a step-by-step guide for personally validating the work done on branch
`demos/09c-architect` (worktree `~/.worktrees/cf-demos-09c`), which implements
[`docs/09C-COLLABORATIVE-EDITING.md`](../../docs/09C-COLLABORATIVE-EDITING.md) end to end: an
owner-managed collaborator model, a bidirectional live-sync `DiagramSession`, and live
presence/cursors/selection highlights on top of the already-shipped `demos/architect` (Demo 9 +
9B).

It has three parts, in the order you should actually do them:

1. **Review the work** — read the plan, the commits, and the design decisions.
2. **Run the automated checks yourself** — no deployment required, a few minutes.
3. **Do the manual, two-identity smoke test against a real deployment** — the only part that
   needs a deployed instance and real Cloudflare Access sign-ins, because it is the only way to
   see two different humans' cursors, presence, and edits together in a browser.

Each phase was implemented by a separate subagent, independently validated (tests re-run,
diffs read), and committed with its own conventional commit — so the git history below is a
reliable, checkable record of what changed and when, not just a narrative.

## What You Need

- The repository already has the worktree set up: `~/.worktrees/cf-demos-09c`, branch
  `demos/09c-architect`, five commits ahead of `main`.
- Node.js 24+ and npm 11+ (Part 2 only).
- For Part 3 only: everything `README.md`'s own Prerequisites section lists (a Cloudflare
  account/zone, a Zero Trust identity provider, an API token) plus **two** real identities you
  can sign in as through that identity provider, and two browser profiles/windows.

## Part 1 — Review The Work

### 1.1 Read the plan and the branch's own history

```sh
cd ~/.worktrees/cf-demos-09c
git log --oneline main..HEAD
```

Expect exactly five commits, one per implementation phase:

```
docs(architect): phase 20 - verification and documentation for collaborative editing
feat(architect): phase 19 - live presence, cursors, and selection highlights
feat(architect): phase 18 - bidirectional live sync via DiagramSession
feat(architect): phase 17 - owner-managed diagram collaborators
docs(architect): phase 16 spike confirms DiagramSession write-chain concurrency model
```

Read [`docs/09C-COLLABORATIVE-EDITING.md`](../../docs/09C-COLLABORATIVE-EDITING.md) itself first —
every phase below implements exactly one of its numbered "Implementation Plan" sections
(Phase 16 through Phase 20), so the spec and the commits should read as a matched pair.

### 1.2 Read each phase's diff

```sh
git show --stat 74590a1   # Phase 16 - spike
git show --stat 917f522   # Phase 17 - collaborator model
git show --stat 0ed0e86   # Phase 18 - bidirectional live sync
git show --stat eb14bf5   # Phase 19 - presence and cursors
git show --stat c406ac6   # Phase 20 - verification and docs
```

Or review the whole branch at once against `main`:

```sh
git diff main..HEAD --stat
```

Worth deliberately checking while reading: **no commit touches `infra/` or
`wrangler.jsonc.tpl`** (confirm with `git diff main..HEAD -- infra/ wrangler.jsonc.tpl`, which
should print nothing) — the source document is explicit that this whole feature needs zero new
Cloudflare product, Access application, policy, or Terraform resource, and the diff should back
that up directly, not just by assertion.

### 1.3 Read the recorded design decisions

Three new entries were added to [`docs/DECISIONS.md`](../../docs/DECISIONS.md) while implementing
this document — each records a real finding, not just a summary of what was built:

| Entry | What it records |
| --- | --- |
| `## 32` | Phase 16's spike (`spikes/08-architect-collab-race/`) proving, by direct execution against a real local `workerd`, that `DiagramSession`'s planned write-chain design has exactly one deterministic winner for two concurrent same-node operations, and that a slow write can never clobber a faster, later one. |
| `## 33` | Phase 18's confirmation that `ctx.id.name` (a March 2026 platform feature) works exactly as needed in this repo's pinned Wrangler version, plus a note on which layer (`applyOperation()` vs. `webSocketMessage()`) actually converts a stale-target error into a non-throwing `operation_rejected` frame. |
| `## 34` | Phase 20's investigation into closing a small, specific coverage gap (two defensive error branches in `ensureHydrated()`), and why it was left as a documented, deliberate gap rather than papering over it with a test-framework escape hatch. |

```sh
sed -n '/^## 32\./,/^## NEW DECISIONS/p' docs/DECISIONS.md | head -n -1
```

(substitute `33`/`34` to read the others)

### 1.4 Spot-check the core design yourself

The highest-value single file to actually read line-by-line is
`demos/architect/src/worker/diagram-session/diagram-session.ts` — it is the object every graph
mutation and every presence signal now goes through, from both a human's browser tab and a 9B MCP
tool call. Confirm for yourself that:

- `this.graph` is only ever mutated synchronously, with no `await` between reading and replacing
  it inside `applyOperation()`.
- Every public method calls `ensureHydrated()` first.
- `persistGraph()` always joins `this.writeChain` rather than writing to D1 independently.

## Part 2 — Run The Automated Checks Yourself

Everything in this part runs entirely locally — no Terraform, no deployment, no real Cloudflare
account.

```sh
cd ~/.worktrees/cf-demos-09c/demos/architect
npm install
```

Then run each of the following and confirm it exits cleanly:

```sh
npm run check:format      # Biome format check
npm run check:lint        # Biome lint
npm run check:types       # tsc --noEmit
npm test                  # all three Vitest projects (worker, client, integration)
npm run test:coverage     # same, plus an Istanbul coverage report
npm run build             # Vite build of both the Worker bundle and the client assets
npm run check:infra:fmt   # terraform fmt -check
npm run check:infra       # terraform validate
```

Expect, at the time this document was written:

- `npm test`: **78 test files, 991 tests, all passing.**
- `npm run test:coverage`: **99.82% statements / 99.6% branches / 100% functions / 99.86%
  lines.** The only two uncovered lines are `diagram-session.ts`'s two defensive
  `ensureHydrated()` error branches (documented in `docs/DECISIONS.md` #34 — genuinely awkward to
  cover in this test pool, not a real gap in the guard logic itself) and one pre-existing,
  unrelated line in `datetime.ts` that predates this document's work entirely.
- `npm run build`: succeeds, producing both `dist/architect_local` (the Worker bundle) and
  `dist/client` (the static assets), with only a pre-existing chunk-size warning for the
  lazily-loaded `elkjs` bundle — unrelated to this feature.
- `npm run check:infra`/`check:infra:fmt`: both report success with **no diff at all** — this
  document adds no Terraform resource.

If any of the above fails, that's a real regression worth stopping on — every one of these passed
cleanly, repeatedly, while this branch was built.

### 2.1 (Optional) Re-run the Phase 16 spike directly

The concurrency spike that grounds the whole design lives outside `demos/architect`, at the repo
root:

```sh
cd ~/.worktrees/cf-demos-09c/spikes/08-architect-collab-race
npm install
npm run test          # two real @cloudflare/vitest-pool-workers race tests
npm run check:types
```

Expect 5 passing tests. This is disposable spike code (see its own `README.md`), not part of the
deployed demo — it exists purely as the executable proof behind `docs/DECISIONS.md` #32.

## Part 3 — Manual Smoke Test Against A Real Deployment

This is the part that actually shows two different humans editing live — nothing in Part 2 opens
a real browser or a real WebSocket between two people, so this is the step that matters most if
you want to *see* the feature work, not just trust the test suite.

### 3.1 Deploy

```sh
cd ~/.worktrees/cf-demos-09c/demos/architect
cp .env.example .env   # fill in your own values, per README.md's Prerequisites
npm run deploy
```

This runs the D1 migration that creates `diagram_collaborators` (`db:migrate:remote`) as part of
the ordinary deploy sequence — no separate migration step is needed.

If you already have a `demos/architect` instance deployed from before this branch existed
(for example, from `main`), `npm run deploy` from this worktree upgrades it in place: Terraform
reports no infrastructure diff (Part 1.2 already confirmed why), and only the D1 migration and the
Worker's code are new.

### 3.2 Run the presenter script's new steps

[`DEMO.md`](./DEMO.md) is the full presenter script; this document's own work added **steps
49–55** at the end of it, plus a third identity (`bob@example.com` by convention) to the
Prerequisites specifically so that identity's first-ever sign-in — the moment it becomes eligible
to be added as a collaborator — happens live. Follow those seven steps directly; they are the
authoritative, most detailed version of this smoke test, and cross-reference
[`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md)'s "Live Collaboration And Concurrency" section for *why*
each behavior works the way it does while you go.

For convenience, here is the condensed version — the minimum needed to confirm the feature
actually works, not the full presenter framing:

1. Sign in to `/app` as your first identity (the diagram owner) and open (or create) a diagram.
2. In the toolbar, open the collaborators control (a distinct icon from **Share**) and try adding
   an email that has never signed in to this deployment. Confirm you get a clear, inline `404`
   ("needs to sign in first") — not a silent success, not a leak of any other information.
3. In a **second** browser profile/window, sign in to `/app` as that second identity for the first
   time. Back in the owner's window, add that email again and confirm it succeeds.
4. In the second identity's window, confirm the diagram now appears under a **"Shared with me"**
   section on their dashboard, annotated with the owner's email. Open it.
5. With both windows open on the same diagram: confirm a presence avatar for the other identity
   appears in each other's toolbar. Move the mouse in one window and confirm a colored, labeled
   cursor tracks live in the other. Drag a node in one window and confirm it moves live in the
   other.
6. In both windows, select the *same* node and type a different label into each at roughly the
   same time. Confirm both windows converge on one final label (whichever operation landed last),
   and that the "losing" window shows an "Updated by `<email>`" toast rather than silently
   reverting with no explanation.
7. If you have an MCP client configured against this deployment (see
   [`MCP-VALIDATION.md`](./MCP-VALIDATION.md)), make one more tool-driven edit to the same diagram
   while both browser windows are still open. Confirm the toast in the owner's window now reads
   **"Updated by your agent"** — distinguishing the agent's edit from the owner's own — even
   though the MCP client authenticates as the same identity as the owner's browser tab.
8. In the second identity's window, open the collaborators control again and select **"Leave
   diagram."** Confirm it disappears from that identity's "Shared with me" section immediately,
   with no effect on the owner's own access.

### 3.3 Confirm what's observable server-side

While doing the above, cross-check the dashboard, matching
[`DEMO.md`](./DEMO.md)'s "Where To Observe State" section:

- **D1** (`architect-db` console): `SELECT * FROM diagram_collaborators;` shows the grant from
  step 3, and disappears after step 8's "Leave diagram."
- **Workers Logs**: filter for `collaborator_added`/`collaborator_removed` and confirm each entry
  carries only a diagram id and an email — never graph content.
- **Durable Objects**: the `DIAGRAM_SESSIONS` binding's active instance for this diagram id now
  reflects every connected collaborator's socket, not only the owner's.
- **Access**: open the `architect app` Access application and confirm its **Destinations** list is
  unchanged from before this deployment — no new application, no new destination was added for
  any of the above.

### 3.4 Tear down when done

```sh
cd ~/.worktrees/cf-demos-09c/demos/architect
npm run teardown
```

## If Something Doesn't Match

- If Part 2's automated checks fail, that is the fastest signal something regressed — it requires
  no deployment to reproduce, and every phase's commit message and this document's Part 1 tell you
  exactly which phase to suspect.
- If Part 3's manual behavior doesn't match, first re-check
  [`README.md`](./README.md)'s Troubleshooting table and [`MCP-VALIDATION.md`](./MCP-VALIDATION.md)'s
  (for anything MCP-related) — most likely causes are a stale browser tab from before this
  deployment (hard-reload once) or the two browser windows genuinely not being signed in as two
  *different* identities.
- If you want a second opinion on any specific design choice (why last-write-wins instead of a
  CRDT, why D1 stays the only durable copy, why the collaborator model is separate from the share
  link), [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md)'s "Live Collaboration And Concurrency" section
  answers each directly, with links to further reading.
