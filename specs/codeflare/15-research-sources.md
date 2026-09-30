# 15 — Research sources

Research completed 30 September 2026. The specification uses current documentation rather than
assuming API behaviour from earlier product releases.

## Product inspiration

- Microsoft, [Introducing the new Copilot with Home, Code and Autopilot](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/) — Code as a sandboxed environment, tenant hosting, Autopilot as persistent agent/workspace/identity.

## Core execution and persistence

- Cloudflare Containers, [Overview](https://developers.cloudflare.com/containers/)
- Cloudflare Containers, [Scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- Cloudflare Containers, [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- Cloudflare Containers, [Use snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
- Cloudflare Containers, [Limits and instance types](https://developers.cloudflare.com/containers/platform/limits/)
- Cloudflare Containers, [Pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- Cloudflare Sandboxes, [Overview](https://developers.cloudflare.com/sandbox/)
- Cloudflare Sandboxes, [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- Cloudflare Sandboxes, [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/)
- Cloudflare Sandboxes, [Build a coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/)
- Cloudflare Sandboxes, [Run coding agents](https://developers.cloudflare.com/sandbox/coding-agents/)
- Cloudflare Sandboxes, [Open a terminal in the browser](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)
- Cloudflare Sandboxes, [Preview a web application](https://developers.cloudflare.com/sandbox/previews/)
- Cloudflare Sandboxes, [Serve previews on their own hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/)
- Cloudflare Sandboxes, [Credentials and network access](https://developers.cloudflare.com/sandbox/network/)

## Git and storage

- Cloudflare Artifacts, [Overview](https://developers.cloudflare.com/artifacts/)
- Cloudflare Artifacts, [Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- Cloudflare Artifacts, [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)
- Cloudflare Artifacts, [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- Cloudflare Artifacts, [Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/)
- Cloudflare Artifacts, [Sandbox SDK + Artifacts](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)
- Cloudflare Artifacts, [Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
- Cloudflare Artifacts, [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)
- Cloudflare Artifacts, [Limits](https://developers.cloudflare.com/artifacts/platform/limits/)

## Agents and AI

- Cloudflare Agents SDK, [Overview](https://developers.cloudflare.com/agents/)
- Cloudflare Agents SDK, [Sandbox tool](https://developers.cloudflare.com/agents/tools/sandbox/)
- Cloudflare Agents SDK, [Tools and harness index](https://developers.cloudflare.com/agents/llms.txt)
- Cloudflare changelog, [Agents SDK background sub-agents and unified turns](https://developers.cloudflare.com/changelog/post/2026-06-26-agents-sdk-v0.17.0/)
- Cloudflare changelog, [Agents SDK browser/code/recovery improvements](https://developers.cloudflare.com/changelog/post/2026-06-16-agents-sdk-v0.16.1/)
- Cloudflare changelog, [@cloudflare/computer preview](https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/)
- [Cloudflare Computer README](https://github.com/cloudflare/computer)
- [Cap'n Web README](https://github.com/cloudflare/capnweb)

## Delivery, access, frontend

- Cloudflare CLI, [`cf` overview](https://developers.cloudflare.com/cf/)
- Cloudflare Workers, [Previews](https://developers.cloudflare.com/workers/previews/)
- Cloudflare Workers, [Preview resource isolation](https://developers.cloudflare.com/workers/previews/resources/)
- Cloudflare Workers, [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [vinext README](https://github.com/cloudflare/vinext)
- Cloudflare changelog, [Cloudflare CLI beta](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/)
- Cloudflare changelog, [Container filesystem snapshots](https://developers.cloudflare.com/changelog/post/2026-09-30-snapshots/)
- Cloudflare changelog, [Sandbox SDK 1.0](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/)
- Cloudflare changelog, [Worker Previews](https://developers.cloudflare.com/changelog/post/2026-09-22-worker-previews/)

## Version observations at research time

| Package | Observed current version |
| --- | --- |
| `cf` | `1.0.0-beta.6` |
| `vinext` | `1.0.0` |
| `@cloudflare/sandbox` | `1.0.0` |
| `@cloudflare/think` | `0.19.0` |
| `@cloudflare/ai-chat` | `0.12.0` |
| `@cloudflare/computer` | `0.3.1` (preview only) |
| `capnweb` | `0.12.0` |
| `@cloudflare/ci` | `0.2.0` |

These are research observations, not implementation pins. The implementing agent must pick and pin
versions deliberately in `codeflare/package.json`, re-checking compatibility at implementation time.
