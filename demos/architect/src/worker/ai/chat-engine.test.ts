import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "../diagrams/types";
import type {
  AiChatRunResult,
  ApplyMutationFn,
  ChatAiBinding,
  RenameDiagramFn,
} from "./chat-engine";

/**
 * Mocks `./docs-client.ts`'s `searchCloudflareDocumentationSafe` for the
 * `search_cloudflare_documentation` tool test below -- matching `docs-client.test.ts`'s own
 * `vi.hoisted()` convention, required because `vi.mock()`'s factory is hoisted above ordinary
 * top-level statements.
 */
const { searchCloudflareDocumentationSafeMock } = vi.hoisted(() => ({
  searchCloudflareDocumentationSafeMock: vi.fn(),
}));

vi.mock("./docs-client", () => ({
  searchCloudflareDocumentationSafe: searchCloudflareDocumentationSafeMock,
}));

const { runDiagramChatTurn } = await import("./chat-engine");

/** An empty fixture graph, mirroring `tools.test.ts`'s own fixture convention. */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** A fixture graph with enough pre-existing nodes/edges that `update_node`/`remove_node`/
 * `add_edge`/`update_edge`/`remove_edge` tool calls can each target a real, existing entity
 * (`executeToolCall()`'s own local-graph-sync step re-runs the real `applyGraphOperation()`
 * against this module's turn-local graph copy, which throws `notFound()` for a target that does
 * not actually exist -- unlike the fixture `applyMutation` spy itself, which accepts anything). */
function graphWithExistingEntities(): GraphData {
  return {
    edges: [
      {
        data: { edgeType: "data-flow" },
        id: "edge-update",
        source: "node-c",
        target: "node-d",
        type: "cf-edge",
      },
      {
        data: { edgeType: "data-flow" },
        id: "edge-remove",
        source: "node-c",
        target: "node-d",
        type: "cf-edge",
      },
    ],
    nodes: [
      { data: { label: "A", typeId: "worker" }, id: "node-a", type: "cf-node" },
      { data: { label: "B", typeId: "worker" }, id: "node-b", type: "cf-node" },
      { data: { label: "C", typeId: "worker" }, id: "node-c", type: "cf-node" },
      { data: { label: "D", typeId: "worker" }, id: "node-d", type: "cf-node" },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * Build a fixture `ReadableStream` of SSE-framed bytes, one `data: <payload>\n\n` frame per
 * already-JSON-stringified payload, terminated by `data: [DONE]\n\n` -- a minimal, simplifying
 * stand-in for Workers AI's own real streaming chunk framing (docs/DECISIONS.md #10 notes real
 * chunk shapes diverge by model/adapter; this fixture only needs to exercise this module's own
 * `consumeSseStream()` parsing, not reproduce every real model's exact shape).
 */
function sseStream(payloads: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Build a fixture `ChatAiBinding` whose `run()` is a bare `vi.fn()` for each test to script via
 * `mockResolvedValueOnce`/a custom implementation. */
function fixtureAi(): { ai: ChatAiBinding; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn();
  return { ai: { run } as unknown as ChatAiBinding, run };
}

/** A `{ response }`-shaped non-streaming result carrying no tool calls -- an organic completion. */
function doneResult(response = "Done."): AiChatRunResult {
  return { response };
}

/** A `{ tool_calls }`-shaped non-streaming result. */
function toolCallResult(
  calls: { name: string; arguments: Record<string, unknown> }[],
): AiChatRunResult {
  return { tool_calls: calls };
}

describe("runDiagramChatTurn", () => {
  const env = {
    AI_CHAT_MODEL: "@cf/test/model",
    AI_GATEWAY_ID: "test-gateway",
  };
  let applyMutation: ReturnType<typeof vi.fn<ApplyMutationFn>>;
  let renameDiagram: ReturnType<typeof vi.fn<RenameDiagramFn>>;
  let onStatus: ReturnType<typeof vi.fn<(message: string) => void>>;
  let onToken: ReturnType<typeof vi.fn<(text: string) => void>>;

  beforeEach(() => {
    applyMutation = vi
      .fn<ApplyMutationFn>()
      .mockResolvedValue({ rejected: false });
    renameDiagram = vi.fn<RenameDiagramFn>().mockResolvedValue(undefined);
    onStatus = vi.fn<(message: string) => void>();
    onToken = vi.fn<(text: string) => void>();
    searchCloudflareDocumentationSafeMock.mockReset();
  });

  it("calls applyMutation with the translated operation for a scripted add_node round, then assembles the streamed final answer", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: {
              label: "API",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            name: "add_node",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult())
      .mockResolvedValueOnce(
        sseStream([
          JSON.stringify({ response: "All " }),
          JSON.stringify({ response: "done." }),
        ]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Add a Worker node.",
      title: "Untitled",
    });

    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledWith({
      input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
      kind: "add_node",
    });
    expect(onStatus).toHaveBeenCalledWith('Adding node "API"…');
    expect(result.toolCallCount).toBe(1);
    expect(result.mutated).toBe(true);
    expect(result.assistantText).toBe("All done.");
    expect(onToken).toHaveBeenCalledWith("All ");
    expect(onToken).toHaveBeenCalledWith("done.");
    // Three total env.AI.run() calls: one tool-calling round, one organic-completion round, one
    // final streamed re-run of that same round (step 4).
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("caps at 8 tool-calling rounds and forces a final round once the cap is hit", async () => {
    const { ai, run } = fixtureAi();
    run.mockImplementation(
      async (_model: string, inputs: { stream?: boolean }) => {
        if (inputs.stream) {
          return sseStream([
            JSON.stringify({ response: "Reached the limit." }),
          ]);
        }
        return toolCallResult([
          {
            arguments: {
              label: "Node",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            name: "add_node",
          },
        ]);
      },
    );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Keep adding nodes forever.",
      title: "Untitled",
    });

    expect(applyMutation).toHaveBeenCalledTimes(8);
    expect(result.toolCallCount).toBe(8);
    expect(result.assistantText).toBe("Reached the limit.");
    // 8 non-streaming tool-calling rounds + 1 final streamed round.
    expect(run).toHaveBeenCalledTimes(9);

    const finalCallArgs = run.mock.calls.at(-1) as unknown[];
    const finalInputs = finalCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    expect(
      finalInputs.messages.some((message) =>
        message.content.includes("action limit"),
      ),
    ).toBe(true);
  });

  it("feeds a rejected applyMutation call back to the model as a tool result instead of throwing", async () => {
    const { ai, run } = fixtureAi();
    applyMutation.mockResolvedValue({
      reason: "Node no longer exists.",
      rejected: true,
    });
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: { nodeId: "stale-node", patch: { label: "Renamed" } },
            name: "update_node",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult("Understood."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Understood." })]),
      );

    const result = await expect(
      runDiagramChatTurn({
        applyMutation,
        description: null,
        env: { ...env, AI: ai },
        graph: emptyGraph(),
        messages: [],
        onStatus,
        onToken,
        renameDiagram,
        text: "Rename that node.",
        title: "Untitled",
      }),
    ).resolves.toMatchObject({ mutated: false, toolCallCount: 1 });
    void result;

    const secondCallArgs = run.mock.calls[1] as unknown[];
    const secondInputs = secondCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    expect(
      secondInputs.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content === "Node no longer exists.",
      ),
    ).toBe(true);
  });

  it("invokes renameDiagram for a rename_diagram tool call", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: { title: "Real-Time Strategy Backend" },
            name: "rename_diagram",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult("Renamed it."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Renamed it." })]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Call it Real-Time Strategy Backend.",
      title: "Untitled",
    });

    expect(renameDiagram).toHaveBeenCalledWith(
      "Real-Time Strategy Backend",
      undefined,
    );
    expect(result.mutated).toBe(true);
  });

  it("invokes searchCloudflareDocumentationSafe for a search_cloudflare_documentation tool call and feeds its result back", async () => {
    searchCloudflareDocumentationSafeMock.mockResolvedValue({
      ok: true,
      results: [
        {
          snippet: "A Durable Object is...",
          title: "Durable Objects",
          url: "https://example.com/do",
        },
      ],
    });
    const { ai, run } = fixtureAi();
    const onDocsLookup = vi.fn();
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: { query: "Durable Objects" },
            name: "search_cloudflare_documentation",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult("Here you go."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Here you go." })]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onDocsLookup,
      onStatus,
      onToken,
      renameDiagram,
      text: "What is a Durable Object?",
      title: "Untitled",
    });

    expect(searchCloudflareDocumentationSafeMock).toHaveBeenCalledWith(
      "Durable Objects",
    );
    expect(onDocsLookup).toHaveBeenCalledWith("Durable Objects", {
      ok: true,
      results: [
        {
          snippet: "A Durable Object is...",
          title: "Durable Objects",
          url: "https://example.com/do",
        },
      ],
    });
    expect(result.mutated).toBe(false);

    const secondCallArgs = run.mock.calls[1] as unknown[];
    const secondInputs = secondCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    const toolMessage = secondInputs.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("Durable Objects");
  });

  it("propagates an uncaught error from the AI binding double rather than swallowing it", async () => {
    const { ai, run } = fixtureAi();
    run.mockRejectedValueOnce(new Error("AI Gateway unavailable"));

    await expect(
      runDiagramChatTurn({
        applyMutation,
        description: null,
        env: { ...env, AI: ai },
        graph: emptyGraph(),
        messages: [],
        onStatus,
        onToken,
        renameDiagram,
        text: "Add a node.",
        title: "Untitled",
      }),
    ).rejects.toThrow("AI Gateway unavailable");
  });

  it("narrates every graph-mutating tool kind and applies each within one round", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: {
              label: "API",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            name: "add_node",
          },
          {
            arguments: { label: "Renamed", nodeId: "node-a" },
            name: "update_node",
          },
          { arguments: { nodeId: "node-b" }, name: "remove_node" },
          {
            arguments: {
              edgeType: "data-flow",
              source: "node-c",
              target: "node-d",
            },
            name: "add_edge",
          },
          {
            arguments: { edgeId: "edge-update", label: "Renamed edge" },
            name: "update_edge",
          },
          { arguments: { edgeId: "edge-remove" }, name: "remove_edge" },
        ]),
      )
      .mockResolvedValueOnce(doneResult("All applied."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "All applied." })]),
      );

    await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: graphWithExistingEntities(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Do everything.",
      title: "Untitled",
    });

    expect(applyMutation).toHaveBeenCalledTimes(6);
    expect(onStatus).toHaveBeenCalledWith('Adding node "API"…');
    expect(onStatus).toHaveBeenCalledWith("Updating node…");
    expect(onStatus).toHaveBeenCalledWith("Removing node…");
    expect(onStatus).toHaveBeenCalledWith("Connecting nodes…");
    expect(onStatus).toHaveBeenCalledWith("Updating connection…");
    expect(onStatus).toHaveBeenCalledWith("Removing connection…");
  });

  it("feeds a tool_error dispatch result (an unrecognized tool name) back to the model", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        toolCallResult([{ arguments: {}, name: "not_a_real_tool" }]),
      )
      .mockResolvedValueOnce(doneResult("Understood."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Understood." })]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Do something unsupported.",
      title: "Untitled",
    });

    expect(applyMutation).not.toHaveBeenCalled();
    expect(result.mutated).toBe(false);

    const secondCallArgs = run.mock.calls[1] as unknown[];
    const secondInputs = secondCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    const toolMessage = secondInputs.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain('Unknown tool "not_a_real_tool"');
  });

  it("throws when a non-streaming, tool-calling round unexpectedly resolves to a ReadableStream", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream([JSON.stringify({ response: "oops" })]),
    );

    await expect(
      runDiagramChatTurn({
        applyMutation,
        description: null,
        env: { ...env, AI: ai },
        graph: emptyGraph(),
        messages: [],
        onStatus,
        onToken,
        renameDiagram,
        text: "Add a node.",
        title: "Untitled",
      }),
    ).rejects.toThrow("received a stream");
  });

  it("treats an unexpected non-streaming response to the final stream:true call as an already-complete answer", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(doneResult("Already complete."))
      .mockResolvedValueOnce(doneResult("Already complete."));

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Explain the diagram.",
      title: "Untitled",
    });

    expect(result.assistantText).toBe("Already complete.");
    expect(onToken).toHaveBeenCalledWith("Already complete.");
  });

  it("skips a malformed (non-JSON) SSE data line and still assembles the rest of the streamed answer", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(doneResult("Ignored."))
      .mockResolvedValueOnce(
        sseStream([
          JSON.stringify({ response: "Good " }),
          "{not valid json",
          JSON.stringify({ response: "text." }),
        ]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Explain the diagram.",
      title: "Untitled",
    });

    expect(result.assistantText).toBe("Good text.");
  });

  it("falls back to a default rejection reason when applyMutation rejects with no reason", async () => {
    const { ai, run } = fixtureAi();
    applyMutation.mockResolvedValue({ rejected: true });
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: {
              label: "API",
              position: { x: 0, y: 0 },
              typeId: "worker",
            },
            name: "add_node",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult("Understood."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Understood." })]),
      );

    await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Add a node.",
      title: "Untitled",
    });

    const secondCallArgs = run.mock.calls[1] as unknown[];
    const secondInputs = secondCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    const toolMessage = secondInputs.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe("Operation rejected.");
  });

  it("calls a search_cloudflare_documentation tool with no onDocsLookup callback wired, and feeds back the unavailable message on a non-fatal failure", async () => {
    searchCloudflareDocumentationSafeMock.mockResolvedValue({
      message: "Documentation search is currently unavailable.",
      ok: false,
    });
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        toolCallResult([
          {
            arguments: { query: "Workers AI" },
            name: "search_cloudflare_documentation",
          },
        ]),
      )
      .mockResolvedValueOnce(doneResult("Sorry, I could not check."))
      .mockResolvedValueOnce(
        sseStream([JSON.stringify({ response: "Sorry, I could not check." })]),
      );

    // No `onDocsLookup` in this call's input at all -- exercises the optional-callback branch.
    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "What is Workers AI?",
      title: "Untitled",
    });

    expect(result.mutated).toBe(false);
    const secondCallArgs = run.mock.calls[1] as unknown[];
    const secondInputs = secondCallArgs[1] as {
      messages: { role: string; content: string }[];
    };
    const toolMessage = secondInputs.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe(
      "Documentation search is currently unavailable.",
    );
  });

  it("ignores a non-object streamed chunk payload (e.g. a bare number) without crashing", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(doneResult("Ignored."))
      .mockResolvedValueOnce(
        sseStream(["42", JSON.stringify({ response: "Real text." })]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Explain the diagram.",
      title: "Untitled",
    });

    expect(result.assistantText).toBe("Real text.");
  });

  it("returns an empty final answer without calling onToken when the defensive non-stream fallback has no response text", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(doneResult("Ignored.")).mockResolvedValueOnce({});

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Explain the diagram.",
      title: "Untitled",
    });

    expect(result.assistantText).toBe("");
    expect(onToken).not.toHaveBeenCalled();
  });

  it("extracts a streamed delta from the openai-chat-adapter choices shape, not only the cf-native response shape", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(doneResult("Ignored."))
      .mockResolvedValueOnce(
        sseStream([
          JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
          JSON.stringify({ choices: [{ delta: {} }] }),
          JSON.stringify({ choices: [{ delta: { content: " there." } }] }),
        ]),
      );

    const result = await runDiagramChatTurn({
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph: emptyGraph(),
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text: "Explain the diagram.",
      title: "Untitled",
    });

    expect(result.assistantText).toBe("Hello there.");
  });
});
