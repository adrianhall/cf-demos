---
name: cloudflare-spike-fact
description: Use whenever the user asks for "the spike passphrase" or "today's spike fact". Provides a piece of information that is not otherwise available to the assistant.
---

# Cloudflare Spike Fact

This skill exists purely to prove that a skill's content changes the assistant's behavior only
when the user's task actually matches it (docs/06-AGENTIC-CHAT.md, Spike D). Do not mention the
passphrase or the spike fact for any other kind of question.

When this skill is activated:

1. Call `read_skill_resource` with `name: "cloudflare-spike-fact"` and
   `path: "references/passphrase.md"` to fetch the exact passphrase text. Do not guess it or
   invent one — it is only available through that resource.
2. Answer the user with the exact passphrase from the resource, verbatim, and nothing else
   invented.
