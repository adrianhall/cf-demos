# Codeflare - An web-based AI-focused coding workspace

Codeflare is a demonstration that demonstrates several capable Cloudflare services.  The idea is to provide capabilities similar to GitHub in an enterprise setting.  All services are provided through a web interface.

## Demo Potential

This demonstration is designed to cover the agentic coding cycle, and explicitly demonstrate:

- Artifacts
- Sandbox SDK / Containers

Future demonstrations are around CI/CD using Cloudflare Workers.

## Versions

### 1. Baseline

Version 1 introduces "Artifacts" and allows the user to create and manage repositories.  Once created, the user can access those repositories through a https-based GIT protocol.  The access is provided by Cloudflare Access and all repositories are "personal" at this stage - there is no permissions structure other than "the repositories I create are only visible to me".  The web frontend shows an interface similar to the home page and repositories pages for GitHub.

### 2. MVP

Version 2 (the MVP) introduces a sandbox similar to "github.dev" - the user can create a session, which creates a sandbox on a branch of the main repository.  Within this branch and sandbox, the user can use a "Monoco" based editor system which includes a terminal in which the user can execute shell commands.  The environment provided includes standard web development commands lines like pnpm and node.

### 3. Previews

Version 3 introduces sandbox previews.  The user can run "npm start" to build and run the site locally and a preview website is made available for the user.  Cloudflare sandbox containers provides this capability already, so it should be relatively easy to implement as well, making v3 small and targetted.

### 4. Agentic Coding

Version 4 introduces an agentic AI coding environment to the sandbox, based on either PiHarness (recently introduced by Cloudflare) or OpenCode (the CLI is readily runnable inside a sandbox), using AI Gateway and Workers AI models (most notably, Kimi-k2.7-code as a baseline).

### Future Version

Future versions will include:

1. Create a repository from a blueprint / scaffold (which may run in a sandbox or via AI)
2. Multi-session orchestrator, allowing the user to orchestrate multiple AI agents from a single point.
3. Enterprise skills deployments, allowing a centralized repository of skills to be made available.
4. Enterprise MCP server deployments, allowing a centralized repository of MCP services to be made available.
5. A website publishing flow to Workers for Platforms with something akin to GitHub Actions.
6. An issue tracking system analogous to "Linear" (i.e. a step up from GitHub Issues and Projects) but applied to the GitHub problem.
7. A project wiki (much like GitHub Wiki, but with a PR/MR twist)
8. Pull request capabilities (merge queue)
9. Repository permissions (view only, editor, admin)
10. Branch protection rules
