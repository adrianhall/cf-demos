import { AgentClient } from "agents/client";
import {
  type MaybeRefOrGetter,
  onScopeDispose,
  type ShallowRef,
  shallowRef,
  toValue,
  watch,
} from "vue";
// Type-only import of a genuinely pure data-shape module: `../../worker/review/types.ts` itself
// imports nothing but `../providers/types` and `./roles` (confirmed by reading both -- neither
// has a single `import` statement of its own), so this Worker module carries no runtime code,
// no `agents`/Hono/D1 dependency, and no side effect of its own for a bundler to ever pull in.
// `import type` is erased entirely at compile time regardless (`tsconfig.json`'s
// `verbatimModuleSyntax: true` enforces writing it this way for exactly this reason), so no part
// of `../../worker` is ever bundled into the client -- unlike this repository's other
// client/Worker shared shapes (`demos/agentic-ai-chat`'s `ChatUsageSummary`, `Chat`), which are
// deliberately duplicated client-side instead because the Worker module they mirror is NOT pure
// (`../../worker/data/reviewRuns.ts`, for example, imports and calls a real D1 query guard at
// module scope). `ReviewRunState`/`ReviewerProgress` have no such duplication risk, so importing
// the real type directly is both safe and the single source of truth for the wire shape
// `ReviewRunAgent` (`../../worker/agents/ReviewRunAgent.ts`) actually broadcasts.
import type {
  ReviewerProgress,
  ReviewRunState,
} from "../../worker/review/types";

/** Lifecycle of this composable's live connection to one run's `ReviewRunAgent` Durable Object.
 * Simpler than `demos/agentic-ai-chat`'s `ChatConnectionStatus`: a review run is never deleted
 * out from under an open detail page, so there is no `"removed"` state to distinguish. */
export type ReviewRunConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

/** One reviewer-lifecycle transition, mirroring the exact payload `ReviewRunAgent`'s
 * `onWorkflowProgress()` broadcasts (`{ type: typedProgress.event, ...typedProgress }` --
 * `../../worker/agents/ReviewRunAgent.ts`): `type` duplicates `ReviewerProgress.event`'s own
 * value (a byproduct of that spread), so this shape only declares `type` and ignores the
 * redundant `event` key the wire payload also happens to carry. */
export interface ReviewerLifecycleEvent {
  readonly type: ReviewerProgress["event"];
  readonly role: ReviewerProgress["role"];
  /** Populated only for a `"cost_reconciled"` event. */
  readonly costUsd?: number;
  /** Populated only for a `"reviewer_skipped"` event. */
  readonly skippedReason?: string;
  /** Populated only for a `"reviewer_completed"` event. */
  readonly findingCount?: number;
  /** Populated only for a `"reviewer_failed"` event. */
  readonly errorDetail?: string;
  /** When this composable observed the event (`Date.now()`) -- lets a watcher distinguish two
   * structurally identical events (two different reviewers both eventually failing, for
   * example) as genuinely separate occurrences to animate. */
  readonly receivedAt: number;
}

/** The run finished successfully, mirroring `ReviewRunAgent.onWorkflowComplete()`'s broadcast. */
export interface ReviewCompletedEvent {
  readonly type: "review_completed";
  readonly commentUrl: string | null;
  readonly receivedAt: number;
}

/** The run failed, mirroring `ReviewRunAgent.onWorkflowError()`'s broadcast. */
export interface ReviewFailedEvent {
  readonly type: "review_failed";
  readonly detail: string;
  readonly receivedAt: number;
}

/** Every broadcast event `ReviewRunAgent` ever sends over its WebSocket connection
 * (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration"), as this composable surfaces them. */
export type ReviewRunEvent =
  | ReviewerLifecycleEvent
  | ReviewCompletedEvent
  | ReviewFailedEvent;

/** How many of the most recent {@link ReviewRunEvent}s {@link UseReviewRunResult.events} keeps.
 * A review run has at most 4 reviewers x 3 lifecycle events each, plus one reconciliation and
 * one terminal event -- comfortably under this cap, so this bound only exists to keep the array
 * from growing unbounded across a very long-lived connection, never to actually drop an event a
 * badge would otherwise need. */
const MAX_RETAINED_EVENTS = 50;

/** Reactive surface {@link useReviewRun} exposes. */
export interface UseReviewRunResult {
  /** This run's live state -- `ReviewRunAgent.state`, kept current automatically via the Agent
   * WebSocket protocol's own `cf_agent_state` frame (both on initial connect hydration and on
   * every later `setState()` push). `null` until the first such frame arrives for this run. */
  readonly state: Readonly<ShallowRef<ReviewRunState | null>>;
  /** Lifecycle of the live WebSocket connection. */
  readonly connectionStatus: Readonly<ShallowRef<ReviewRunConnectionStatus>>;
  /**
   * Every broadcast event this connection has observed for the current run, oldest first,
   * capped at {@link MAX_RETAINED_EVENTS} -- a genuine stream a component can watch (for example
   * filtering to just one reviewer's own events) to animate a badge transition, distinct from
   * {@link state} itself: a change in `state.reviewers` alone cannot tell a badge *when* a
   * transition just happened versus merely reflecting one that happened before this page ever
   * connected (mirrors why `demos/agentic-ai-chat`'s `useChatAgent` exposes a separate
   * `lastReconciliationEvent` alongside its own already-current `usage` ref). An array (rather
   * than a single "last event" ref, that composable's own choice) is used here instead because
   * this run can have up to four reviewers transitioning independently; a single slot could
   * silently drop one reviewer's event if two different reviewers' events arrive within the
   * same microtask.
   */
  readonly events: Readonly<ShallowRef<readonly ReviewRunEvent[]>>;
}

/** Every event `type` this composable recognizes on the wire -- anything else (for example the
 * Agent WebSocket protocol's own `cf_agent_state` state-sync frame, which `AgentClient` already
 * consumes independently via `onStateUpdate`) is ignored by {@link handleMessage}. */
const REVIEWER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "reviewer_started",
  "reviewer_completed",
  "reviewer_skipped",
  "reviewer_failed",
  "cost_reconciled",
]);

/**
 * Connect to one review run's live `ReviewRunAgent` Durable Object over its Agents SDK WebSocket
 * (docs/07-PR-REVIEW-AGENT.md, "API And Routing": `/agents/review-run/:id`; Implementation Plan
 * Phase 6, item 26). Built directly on `agents/client`'s framework-agnostic `AgentClient`,
 * mirroring `demos/agentic-ai-chat/src/client/composables/useChatAgent.ts`'s own precedent as
 * "the one place this demo speaks the Agent WebSocket wire protocol" -- every Pinia store and
 * component consumes this composable's reactive surface instead of `AgentClient` directly.
 *
 * Unlike `useChatAgent`, this composable passes no `basePath`: `ReviewRunAgent` is routed
 * through the Agents SDK's own default `/agents/{namespace}/{name}` convention
 * (`../../worker/index.ts`'s `routeAgentRequest()`). That "namespace" segment is **not** the
 * Agent class name kebab-cased -- confirmed wrong by this module's own colocated test, which
 * caught it directly against the real `agents`/`partyserver` packages rather than trusting
 * either the scenario doc's prose or this composable's own first draft: `routeAgentRequest()`
 * delegates to `partyserver`'s `routePartykitRequest()`
 * (`node_modules/agents/dist/index.js`), which builds its routing table from the Worker's own
 * `env` **binding keys** (`Object.entries(env)`, keeping only Durable-Object-shaped bindings),
 * kebab-casing each one with the exact same `camelCaseToKebabCase()` helper
 * (`node_modules/partyserver/dist/index.js`) `AgentClient` itself uses client-side
 * (`node_modules/agents/dist/client.js` imports the identical function from `agents`' own
 * `utils.js`) -- never the Durable Object *class* name at all. `camelCaseToKebabCase()`'s own
 * all-uppercase branch (`str === str.toUpperCase()`) lowercases and turns underscores into
 * hyphens, so `wrangler.jsonc`'s `REVIEW_RUN` binding name kebab-cases to exactly `review-run` --
 * matching docs/07-PR-REVIEW-AGENT.md's own `/agents/review-run/:id`, but only because
 * `agent: "REVIEW_RUN"` (the *binding* name) is passed below, not `agent: "ReviewRunAgent"` (the
 * class name, which would instead kebab-case to the wrong `review-run-agent` and 400 against the
 * server's own routing table). `basePath` is documented as bypassing the `agent`/`name` URL
 * construction entirely ("ignored if basePath is set" -- `node_modules/agents/dist/client.d.ts`),
 * so with the correct binding name, no `basePath` override is needed at all.
 *
 * This composable never talks to `ReviewPipelineWorkflow` directly -- from the browser's side,
 * the only observable surface is still the Agent's `state`/broadcast, exactly as
 * docs/07-PR-REVIEW-AGENT.md's own Implementation Plan Phase 6, item 26 requires ("Review
 * Orchestration" is a server-side implementation detail the client is not, and should not be,
 * aware of).
 *
 * @param runId The run to connect to. Accepts a plain string, ref, or getter
 * (`create-adaptable-composable` convention) so a caller can pass a reactive route param;
 * switching to a different id closes the previous connection and opens a new one, resetting
 * every reactive field back to its initial value first.
 * @returns The reactive state/connection-status/events surface. The underlying socket is closed
 * automatically on scope disposal (`onScopeDispose`) -- callers never need to close it manually.
 */
export function useReviewRun(
  runId: MaybeRefOrGetter<string>,
): UseReviewRunResult {
  const state = shallowRef<ReviewRunState | null>(null);
  const connectionStatus = shallowRef<ReviewRunConnectionStatus>("idle");
  const events = shallowRef<readonly ReviewRunEvent[]>([]);

  let client: AgentClient | null = null;

  /** Append one event, keeping at most {@link MAX_RETAINED_EVENTS}. */
  function pushEvent(event: ReviewRunEvent): void {
    const next = [...events.value, event];
    events.value =
      next.length > MAX_RETAINED_EVENTS
        ? next.slice(next.length - MAX_RETAINED_EVENTS)
        : next;
  }

  /** Raw WebSocket `message` handler -- ignores every frame type this composable does not act
   * on (identity, RPC, and the `cf_agent_state` frame; `AgentClient` itself already consumes
   * the latter independently of this listener, via `onStateUpdate` below, mirroring
   * `useChatAgent.ts`'s own documented dual-listener behavior). */
  function handleMessage(messageEvent: MessageEvent): void {
    if (typeof messageEvent.data !== "string") {
      return;
    }
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(messageEvent.data) as { type?: string };
    } catch {
      return;
    }
    const receivedAt = Date.now();
    if (typeof parsed.type !== "string") {
      return;
    }
    if (REVIEWER_EVENT_TYPES.has(parsed.type)) {
      pushEvent({
        ...(parsed as Omit<ReviewerLifecycleEvent, "receivedAt">),
        receivedAt,
      });
    } else if (parsed.type === "review_completed") {
      pushEvent({
        type: "review_completed",
        commentUrl:
          (parsed as { commentUrl?: string | null }).commentUrl ?? null,
        receivedAt,
      });
    } else if (parsed.type === "review_failed") {
      pushEvent({
        type: "review_failed",
        detail: (parsed as { detail?: string }).detail ?? "Unknown error.",
        receivedAt,
      });
    }
  }

  /** Close and forget the current connection, if any. Safe to call when already idle. */
  function teardown(): void {
    const socket = client;
    client = null;
    socket?.close();
  }

  /** Reset every reactive field and open a new connection for `id`. */
  function connect(id: string): void {
    connectionStatus.value = "connecting";
    state.value = null;
    events.value = [];

    const socket = new AgentClient({
      // The Wrangler binding name (`wrangler.jsonc.tpl`'s `REVIEW_RUN`), not the Durable Object
      // class name -- see this function's own doc comment above for why.
      agent: "REVIEW_RUN",
      name: id,
      host: window.location.host,
      // The Agent WebSocket protocol's own `cf_agent_state` frame, delivered both on initial
      // connect (hydrating whatever this run's state already is -- durable, even for a client
      // connecting after every reviewer already finished) and on every later `setState()` push
      // (docs/07-PR-REVIEW-AGENT.md, "Data Model": "`state` is a live projection for whichever
      // run is currently open").
      onStateUpdate: (nextState) => {
        state.value = nextState as ReviewRunState;
      },
    });
    client = socket;

    // Every listener guards with `client !== socket` before touching reactive state: an
    // intentional `teardown()` closing this exact socket still synchronously fires its own
    // "close" handling (and, depending on timing, a queued "error"), which must not be mistaken
    // for an unexpected drop of whatever connection is now current. `useChatAgent.ts` guards
    // only "close" (relying on `ReconnectingWebSocket`'s own synchronous raw-listener removal to
    // make "open"/"error" structurally unreachable after teardown) -- this composable guards all
    // three uniformly instead, a simpler invariant to keep correct than depending on that
    // library-internal removal order.
    socket.addEventListener("open", () => {
      connectionStatus.value = "connected";
    });
    socket.addEventListener("close", () => {
      if (client !== socket) {
        return;
      }
      connectionStatus.value = "connecting";
    });
    socket.addEventListener("error", () => {
      if (client !== socket) {
        return;
      }
      connectionStatus.value = "error";
    });
    socket.addEventListener("message", handleMessage);
  }

  watch(
    () => toValue(runId),
    (id, _previous, onCleanup) => {
      onCleanup(() => teardown());
      connect(id);
    },
    { immediate: true },
  );

  onScopeDispose(() => teardown());

  return { state, connectionStatus, events };
}
