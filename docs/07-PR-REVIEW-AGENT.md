# Demo 7: PR Review Agent

Directory: `demos/review-agent`

Domain: `review-agent.cfapps.uk`

Status: Draft

## Goal

Using agentic AI tools, provide a PR (Pull Request) or MR (Merge Request) review agent for GitHub and GitLab, covering software architecture, code quality, accessibility, and security.  At the end, the consolidated review is added to the PR as a comment and the full report is available as a link on the UI.  The review can be triggered either by a webhook (from GitHub/GitLab) OR by entering the PR URL into the UI.

## Prior Art

The repo <https://github.com/adrianhall/opencode-setup> contains a set of OpenCode agents for this purpose.  It is generally run as OpenCode agents on the checked out PR.

The [reviewbot-agent](../../reviewbot-agent/) provides a "lab" version of a reviewbot that uses chat to trigger the review.  This is formed from the lab at <https://agents-school.tiwi.me>.
