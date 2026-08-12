# ISSUE 6: (Architect) "Open in Editor" loses the AI conversation

## What happens

From `/blueprints`, "Generate with AI" produces a diagram inside a modal, then offers an
"Open in Editor" button. Clicking it does a full page navigation to `/app/diagram/:id`, and the
editor lands with:

- the right-hand sidebar **closed**, on the **Properties** tab, so there is no sign the AI
  assistant exists at all; and
- an **empty** chat transcript, with none of the conversation that just built the diagram.

There is no way to pick the conversation back up. The user has to notice the toolbar's message
icon, click it, and start over from an empty panel.

## What was asked for

> I'd appreciate a continue in editor where the editor opens with the chat already open and I can
> continue the conversation.

## Why it happens today

Three independent gaps, none of which is a bug in isolation:

1. **Nothing carries state across the navigation.**
   `GenerateWithAiModal.handleOpenInEditor()` navigates with
   `window.location.href = /app/diagram/${diagramId}`. There is no router library in this client —
   `App.tsx` and `AppShellView.tsx` both match on `window.location.pathname` alone — and a
   repository-wide search of `src/client` finds no use of `location.search`, `URLSearchParams`,
   `location.hash`, `history.pushState` or `history.state`. So there is no existing mechanism to
   say "open on the chat tab".

2. **The chat tab cannot be requested, and is deliberately not remembered.**
   Panel visibility is the product of `propertiesOpen` (does the sidebar show at all?) and
   `detailsPanelTab === "ai-chat"`. Both initialise to closed/Properties in `diagramStore.ts`,
   and only the panel's *width* is persisted — `details-panel-preferences.ts` states outright that
   the active tab deliberately is not.

3. **The transcript lives only in component state, and the model's own history is
   per-connection.** `useDiagramLiveSync` holds `chatTranscript` in local React state, scoped to
   one component subtree; a hard navigation discards it. Server-side, `DiagramSession` keeps the
   turn's message history per **WebSocket connection**, so even a rehydrated UI transcript would
   be talking to a model with no memory of it.

Gap 3 is the substantive one. Gaps 1 and 2 are a few lines each; gap 3 is a design question.

## Suggested direction

The cheap fix — carry a flag on the URL and land on the chat tab — solves the stated request but
leaves the transcript blank and the model amnesiac, so a follow-up like "actually, drop the KV
node you added" cannot work.

The more interesting fix, and the better demo, is to **persist the conversation in the
`DiagramSession` Durable Object** rather than per connection: move the chat message history into
the object's own SQLite storage keyed by diagram, replay it to a newly-connected client so the
transcript rehydrates, and feed it back to the model on the next turn. That turns the assistant
from a stateless one-shot into a genuine agentic loop over the diagram, which is what the object
is already well-placed to be — it is a single-threaded coordination point that already owns the
authoritative graph, already serialises every mutation, and already broadcasts to every viewer.

Worth considering alongside that:

- Whether history should be per-diagram (every collaborator shares one conversation, matching how
  the graph itself works) or per-identity. Per-diagram is more consistent with the rest of 9C/9D
  and makes the assistant a shared participant.
- A cap and/or summarisation, since diagram-scoped history grows without bound.
- Whether the Agents SDK is a better fit than a hand-rolled history table, given the demo already
  depends on `agents`.
- Once history is durable, "Open in Editor" needs nothing special beyond landing on the chat tab —
  the transcript rehydrates from the object like the graph does.

## Related

- `docs/09D-ARCHITECT-AICHAT.md` — the AI chat design this extends.
- `docs/DECISIONS.md` #43 — the transcript ordering/duplication fixes, which touched the same
  client-side transcript model.
