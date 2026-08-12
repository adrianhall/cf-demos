import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "../diagrams/types";
import type {
  AiChatRunResult,
  ApplyMutationFn,
  ChatAiBinding,
  RenameDiagramFn,
  WireToolCall,
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

/** The shape of one entry in a round's `messages` input, as these tests inspect it. */
interface InspectedMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** The shape of one `env.AI.run()` call's `inputs` argument, as these tests inspect it. */
interface InspectedInputs {
  messages: InspectedMessage[];
  tools?: { name: string }[];
  stream?: boolean;
}

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
 * already-JSON-stringified payload, terminated by `data: [DONE]\n\n` -- the framing the real
 * model uses (docs/DECISIONS.md #42).
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

/** One `choices[0].delta`-shaped SSE payload. */
function deltaPayload(delta: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ delta, finish_reason: null, index: 0 }],
  });
}

/**
 * Build a streamed, text-only round in the real `openai-chat` chunk shape -- one
 * `choices[0].delta.content` fragment per argument.
 */
function sseTextRound(...chunks: string[]): ReadableStream<Uint8Array> {
  return sseStream(chunks.map((content) => deltaPayload({ content })));
}

/**
 * Build a streamed tool-calling round in the **real** wire shape recorded in docs/DECISIONS.md
 * #37: an opening fragment per call carrying `index`/`id`/`function.name` with empty arguments,
 * then argument text delivered in fragments that carry `id: null`/`name: null`. Every call's
 * arguments are deliberately split across two fragments so the accumulator's concatenation is
 * actually exercised rather than trivially satisfied by a single whole-JSON fragment.
 *
 * @param calls The tool calls to stream. A `string` `arguments` value is streamed verbatim,
 * which is how a malformed-arguments case is expressed.
 * @param text Optional trailing natural-language content for the same round.
 */
function sseToolCallRound(
  calls: { name: string; arguments: unknown }[],
  text = "",
): ReadableStream<Uint8Array> {
  const payloads: string[] = [];
  calls.forEach((call, index) => {
    const argumentsText =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments);
    payloads.push(
      deltaPayload({
        tool_calls: [
          {
            function: { arguments: "", name: call.name },
            id: `call_${index}`,
            index,
            type: "function",
          },
        ],
      }),
    );
    const split = Math.ceil(argumentsText.length / 2);
    for (const fragment of [
      argumentsText.slice(0, split),
      argumentsText.slice(split),
    ]) {
      payloads.push(
        deltaPayload({
          tool_calls: [
            {
              function: { arguments: fragment, name: null },
              id: null,
              index,
              type: "function",
            },
          ],
        }),
      );
    }
  });
  if (text.length > 0) payloads.push(deltaPayload({ content: text }));
  return sseStream(payloads);
}

/** Build a fixture `ChatAiBinding` whose `run()` is a bare `vi.fn()` for each test to script via
 * `mockResolvedValueOnce`/a custom implementation. */
function fixtureAi(): { ai: ChatAiBinding; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn();
  return { ai: { run } as unknown as ChatAiBinding, run };
}

/** Read one recorded `env.AI.run()` call's `inputs` argument. */
function inputsOfCall(
  run: ReturnType<typeof vi.fn>,
  index: number,
): InspectedInputs {
  const call = run.mock.calls[index] as unknown[];
  return call[1] as InspectedInputs;
}

/** Find the first `role: "tool"` message in one recorded round's `messages`. */
function toolMessageOfCall(
  run: ReturnType<typeof vi.fn>,
  index: number,
): InspectedMessage | undefined {
  return inputsOfCall(run, index).messages.find(
    (message) => message.role === "tool",
  );
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

  /** The shared input every test below varies only a few fields of. */
  function turnInput(ai: ChatAiBinding, text: string, graph = emptyGraph()) {
    return {
      applyMutation,
      description: null,
      env: { ...env, AI: ai },
      graph,
      messages: [],
      onStatus,
      onToken,
      renameDiagram,
      text,
      title: "Untitled",
    };
  }

  beforeEach(() => {
    applyMutation = vi
      .fn<ApplyMutationFn>()
      .mockResolvedValue({ rejected: false });
    renameDiagram = vi.fn<RenameDiagramFn>().mockResolvedValue(undefined);
    onStatus = vi.fn<(message: string) => void>();
    onToken = vi.fn<(text: string) => void>();
    searchCloudflareDocumentationSafeMock.mockReset();
  });

  it("assembles a streamed add_node tool call, applies it, and streams the final answer in one round each", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
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
      .mockResolvedValueOnce(sseTextRound("All ", "done."));

    const result = await runDiagramChatTurn(
      turnInput(ai, "Add a Worker node."),
    );

    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledWith({
      input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
      kind: "add_node",
    });
    expect(result.toolCallCount).toBe(1);
    expect(result.mutated).toBe(true);
    expect(result.assistantText).toBe("All done.");
    expect(onToken).toHaveBeenCalledWith("All ");
    expect(onToken).toHaveBeenCalledWith("done.");
    // Exactly one inference call per round: one tool-calling round, one final answer. The
    // earlier design's discarded non-streaming duplicate of the final round is gone
    // (docs/DECISIONS.md #42).
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("streams every round and carries the tool catalog on every round, including the final answer", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          { arguments: { title: "Renamed" }, name: "rename_diagram" },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Done."));

    await runDiagramChatTurn(turnInput(ai, "Rename it."));

    expect(run).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 2; index += 1) {
      const inputs = inputsOfCall(run, index);
      expect(inputs.stream).toBe(true);
      // A tool-instructing system prompt must never be sent without the tools themselves --
      // spikes/03-agent-skills-composability/REPORT.md §7, docs/ISSUE-5.md.
      expect(inputs.tools?.map((tool) => tool.name)).toContain("add_node");
    }
  });

  it("echoes tool calls back as an OpenAI-shaped assistant message and correlates each tool result by tool_call_id", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          { arguments: { label: "API", typeId: "worker" }, name: "add_node" },
          { arguments: { title: "Renamed" }, name: "rename_diagram" },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Done."));

    await runDiagramChatTurn(turnInput(ai, "Build it."));

    const { messages } = inputsOfCall(run, 1);
    const assistant = messages.find(
      (message) => message.role === "assistant" && message.tool_calls,
    );
    expect(assistant?.content).toBeNull();
    expect(assistant?.tool_calls).toHaveLength(2);
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      function: { name: "add_node" },
      id: "call_0",
      type: "function",
    });
    expect(
      JSON.parse(assistant?.tool_calls?.[0]?.function.arguments ?? "{}"),
    ).toEqual({ label: "API", typeId: "worker" });

    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
      "call_0",
      "call_1",
    ]);
    // `add_node`'s result reports the server-minted id back, so a later round can target it --
    // see the "created id" tests below.
    expect(toolMessages[0]?.content).toMatch(
      /^Operation applied\. Created node id: /,
    );
    expect(toolMessages[1]?.content).toBe("Diagram renamed.");
  });

  it("caps at 8 tool-calling rounds and runs exactly one further round for the final answer", async () => {
    const { ai, run } = fixtureAi();
    let round = 0;
    run.mockImplementation(async () => {
      round += 1;
      if (round > 8) return sseTextRound("Reached the limit.");
      return sseToolCallRound([
        {
          arguments: {
            label: "Node",
            position: { x: 0, y: 0 },
            typeId: "worker",
          },
          name: "add_node",
        },
      ]);
    });

    const result = await runDiagramChatTurn(
      turnInput(ai, "Keep adding nodes forever."),
    );

    expect(applyMutation).toHaveBeenCalledTimes(8);
    expect(result.toolCallCount).toBe(8);
    expect(result.assistantText).toBe("Reached the limit.");
    // 8 tool-calling rounds + 1 final round.
    expect(run).toHaveBeenCalledTimes(9);

    const limitMessage = inputsOfCall(run, 8).messages.find((message) =>
      message.content?.includes("action limit"),
    );
    // Sent as `system`, not `tool`: a `role: "tool"` message must answer a specific
    // `tool_call_id`, and this one answers none.
    expect(limitMessage?.role).toBe("system");
  });

  it("ignores tool calls made by the extra post-cap round instead of looping forever", async () => {
    const { ai, run } = fixtureAi();
    run.mockImplementation(async () =>
      sseToolCallRound([
        { arguments: { label: "Node", typeId: "worker" }, name: "add_node" },
      ]),
    );

    const result = await runDiagramChatTurn(turnInput(ai, "Never stop."));

    expect(run).toHaveBeenCalledTimes(9);
    expect(result.toolCallCount).toBe(8);
  });

  it("feeds a rejected applyMutation call back to the model as a tool result instead of throwing", async () => {
    const { ai, run } = fixtureAi();
    applyMutation.mockResolvedValue({
      reason: "Node no longer exists.",
      rejected: true,
    });
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          {
            arguments: { nodeId: "stale-node", label: "Renamed" },
            name: "update_node",
          },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Understood."));

    await expect(
      runDiagramChatTurn(turnInput(ai, "Rename that node.")),
    ).resolves.toMatchObject({ mutated: false, toolCallCount: 1 });

    expect(toolMessageOfCall(run, 1)?.content).toBe("Node no longer exists.");
  });

  it("falls back to a default rejection reason when applyMutation rejects with no reason", async () => {
    const { ai, run } = fixtureAi();
    applyMutation.mockResolvedValue({ rejected: true });
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
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
      .mockResolvedValueOnce(sseTextRound("Understood."));

    await runDiagramChatTurn(turnInput(ai, "Add a node."));

    expect(toolMessageOfCall(run, 1)?.content).toBe("Operation rejected.");
  });

  it("invokes renameDiagram for a rename_diagram tool call", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          {
            arguments: { title: "Real-Time Strategy Backend" },
            name: "rename_diagram",
          },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Renamed it."));

    const result = await runDiagramChatTurn(
      turnInput(ai, "Call it Real-Time Strategy Backend."),
    );

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
        sseToolCallRound([
          {
            arguments: { query: "Durable Objects" },
            name: "search_cloudflare_documentation",
          },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Here you go."));

    const result = await runDiagramChatTurn({
      ...turnInput(ai, "What is a Durable Object?"),
      onDocsLookup,
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
    expect(toolMessageOfCall(run, 1)?.content).toContain("Durable Objects");
  });

  it("calls a search_cloudflare_documentation tool with no onDocsLookup callback wired, and feeds back the unavailable message on a non-fatal failure", async () => {
    searchCloudflareDocumentationSafeMock.mockResolvedValue({
      message: "Documentation search is currently unavailable.",
      ok: false,
    });
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          {
            arguments: { query: "Workers AI" },
            name: "search_cloudflare_documentation",
          },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Sorry, I could not check."));

    // No `onDocsLookup` in this call's input at all -- exercises the optional-callback branch.
    const result = await runDiagramChatTurn(
      turnInput(ai, "What is Workers AI?"),
    );

    expect(result.mutated).toBe(false);
    expect(toolMessageOfCall(run, 1)?.content).toBe(
      "Documentation search is currently unavailable.",
    );
  });

  it("propagates an uncaught error from the AI binding double rather than swallowing it", async () => {
    const { ai, run } = fixtureAi();
    run.mockRejectedValueOnce(new Error("AI Gateway unavailable"));

    await expect(
      runDiagramChatTurn(turnInput(ai, "Add a node.")),
    ).rejects.toThrow("AI Gateway unavailable");
  });

  it("applies every graph-mutating tool kind within one round, narrating none of them", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
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
      .mockResolvedValueOnce(sseTextRound("All applied."));

    await runDiagramChatTurn(
      turnInput(ai, "Do everything.", graphWithExistingEntities()),
    );

    expect(applyMutation).toHaveBeenCalledTimes(6);
    // A graph mutation narrates itself through the `operation_applied` broadcast the client
    // renders as an `"action"` entry. Emitting a status here too produced two transcript lines
    // per operation, and -- because it fired *before* `applyMutation` -- announced operations
    // that were then rejected. See docs/DECISIONS.md #43.
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("still narrates the tools that produce no broadcast of their own", async () => {
    const { ai, run } = fixtureAi();
    searchCloudflareDocumentationSafeMock.mockResolvedValue({
      ok: true,
      results: [],
    });
    run
      .mockResolvedValueOnce(
        sseToolCallRound([
          { arguments: { title: "Renamed" }, name: "rename_diagram" },
          {
            arguments: { query: "durable objects" },
            name: "search_cloudflare_documentation",
          },
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Done."));

    await runDiagramChatTurn(turnInput(ai, "Rename and research."));

    expect(onStatus).toHaveBeenCalledWith("Renaming the diagram…");
    expect(onStatus).toHaveBeenCalledWith(
      'Checking Cloudflare docs for "durable objects"…',
    );
  });

  it("feeds a tool_error dispatch result (an unrecognized tool name) back to the model", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([{ arguments: {}, name: "not_a_real_tool" }]),
      )
      .mockResolvedValueOnce(sseTextRound("Understood."));

    const result = await runDiagramChatTurn(
      turnInput(ai, "Do something unsupported."),
    );

    expect(applyMutation).not.toHaveBeenCalled();
    expect(result.mutated).toBe(false);
    expect(toolMessageOfCall(run, 1)?.content).toContain(
      'Unknown tool "not_a_real_tool"',
    );
  });

  it("reports malformed streamed tool arguments back to the model as a tool error instead of throwing", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([{ arguments: "{not valid json", name: "add_node" }]),
      )
      .mockResolvedValueOnce(sseTextRound("Let me retry."));

    const result = await runDiagramChatTurn(turnInput(ai, "Add a node."));

    expect(applyMutation).not.toHaveBeenCalled();
    expect(result.toolCallCount).toBe(1);
    expect(toolMessageOfCall(run, 1)?.content).toContain(
      'Invalid arguments for "add_node"',
    );
  });

  describe("truncated streamed tool arguments", () => {
    it("repairs the model's dropped closing brace when a tool call's last argument is a nested object", async () => {
      const { ai, run } = fixtureAi();
      // The confirmed live defect (docs/DECISIONS.md #42): `{"...","position":{"x":0,"y":0}}`
      // arrives one `}` short, so every single `add_node` carrying a `position` was invalid JSON.
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments:
                '{"typeId":"worker","label":"API","position":{"x":120,"y":40}',
              name: "add_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Added it."));

      const result = await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      expect(applyMutation).toHaveBeenCalledWith({
        input: { label: "API", position: { x: 120, y: 40 }, typeId: "worker" },
        kind: "add_node",
      });
      expect(result.mutated).toBe(true);
    });

    it("re-serializes the repaired arguments when echoing the tool call back to the model", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: '{"typeId":"d1","label":"DB","position":{"x":0,"y":0}',
              name: "add_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Added it."));

      await runDiagramChatTurn(turnInput(ai, "Add D1."));

      // Echoing the raw, still-truncated text back is a hard 400 from the model
      // ("Assistant tool call function.arguments must be valid JSON"), so the echo must carry
      // the *repaired* document.
      const echoed = inputsOfCall(run, 1).messages.find(
        (message) => message.role === "assistant" && message.tool_calls,
      )?.tool_calls?.[0]?.function.arguments;
      expect(() => JSON.parse(echoed ?? "")).not.toThrow();
      expect(JSON.parse(echoed ?? "")).toEqual({
        label: "DB",
        position: { x: 0, y: 0 },
        typeId: "d1",
      });
    });

    it("echoes empty-object arguments rather than unparseable text the model would reject", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            { arguments: "{not valid json", name: "add_node" },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Let me retry."));

      await runDiagramChatTurn(turnInput(ai, "Add a node."));

      const echoed = inputsOfCall(run, 1).messages.find(
        (message) => message.role === "assistant" && message.tool_calls,
      )?.tool_calls?.[0]?.function.arguments;
      expect(echoed).toBe("{}");
    });

    it("does not mistake an escaped quote inside a string for the end of that string", async () => {
      const { ai, run } = fixtureAi();
      // A naive scanner would treat the `\"` pair as closing the label and then see the rest of
      // the document as structure, mis-counting the open braces it has to close.
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments:
                '{"typeId":"worker","label":"He said \\"hi\\" {","position":{"x":0,"y":0}',
              name: "add_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Added it."));

      await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      expect(applyMutation).toHaveBeenCalledWith({
        input: {
          label: 'He said "hi" {',
          position: { x: 0, y: 0 },
          typeId: "worker",
        },
        kind: "add_node",
      });
    });

    it("closes a truncated array as well as a truncated object", async () => {
      const { ai, run } = fixtureAi();
      // No current tool takes an array argument, but the repair runs before zod does, so a model
      // emitting an unexpected array must still produce a parseable document rather than a
      // spurious "invalid arguments" error about truncation.
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: '{"typeId":"worker","label":"API","tags":["a","b"',
              name: "add_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Added it."));

      await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      // The unknown `tags` key is stripped by the tool's own schema, and the omitted `position`
      // is filled in by `nextGridPosition()`; what matters is that the call parsed at all
      // instead of being reported back as malformed.
      expect(applyMutation).toHaveBeenCalledTimes(1);
      expect(applyMutation.mock.calls[0]?.[0]).toMatchObject({
        input: { label: "API", typeId: "worker" },
        kind: "add_node",
      });
    });

    it("refuses to repair arguments truncated mid-string, reporting a tool error instead", async () => {
      const { ai, run } = fixtureAi();
      // Closing the dangling quote would silently invent a truncated label; an honest tool error
      // the model can retry is the better outcome.
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: '{"typeId":"worker","label":"Partial la',
              name: "add_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Let me retry."));

      await runDiagramChatTurn(turnInput(ai, "Add a node."));

      expect(applyMutation).not.toHaveBeenCalled();
      expect(toolMessageOfCall(run, 1)?.content).toContain(
        'Invalid arguments for "add_node"',
      );
    });

    it("does not treat mismatched closers as repairable truncation", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            { arguments: '{"typeId":"worker"]', name: "add_node" },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Let me retry."));

      await runDiagramChatTurn(turnInput(ai, "Add a node."));

      expect(applyMutation).not.toHaveBeenCalled();
      expect(toolMessageOfCall(run, 1)?.content).toContain(
        'Invalid arguments for "add_node"',
      );
    });
  });

  describe("server-minted ids fed back to the model", () => {
    it("reports the created node id, and the graph digest of the next round uses the graph applyMutation returned", async () => {
      const { ai, run } = fixtureAi();
      // The authoritative graph belongs to the caller (DiagramSession), whose `applyOperation()`
      // mints its own `crypto.randomUUID()`. When it hands that graph back, the engine must adopt
      // it -- re-deriving a local copy instead produces *different* ids, so every later
      // `add_edge` names a node that does not exist and is rejected (docs/DECISIONS.md #42).
      const authoritative: GraphData = {
        edges: [],
        nodes: [
          {
            data: { label: "API", typeId: "worker" },
            id: "server-minted-node",
            type: "cf-node",
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      applyMutation.mockResolvedValue({
        graph: authoritative,
        rejected: false,
      });
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            { arguments: { label: "API", typeId: "worker" }, name: "add_node" },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Added it."));

      await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      expect(toolMessageOfCall(run, 1)?.content).toContain(
        "Created node id: server-minted-node",
      );
      // The next round's rebuilt system prompt must show the same id the tool result reported.
      const system = inputsOfCall(run, 1).messages[0];
      expect(system.role).toBe("system");
      expect(system.content).toContain("id: server-minted-node");
    });

    it("falls back to a bare confirmation when the returned graph gained nothing", async () => {
      const { ai, run } = fixtureAi();
      // A caller that reports success without actually adding anything has no id to name.
      applyMutation.mockResolvedValue({ graph: emptyGraph(), rejected: false });
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            { arguments: { label: "API", typeId: "worker" }, name: "add_node" },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Done."));

      await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      expect(toolMessageOfCall(run, 1)?.content).toBe("Operation applied.");
    });

    it("falls back to a bare confirmation when the created entity's id is not a string", async () => {
      const { ai, run } = fixtureAi();
      applyMutation.mockResolvedValue({
        graph: {
          edges: [],
          nodes: [{ data: { label: "API", typeId: "worker" }, id: 7 }],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        rejected: false,
      });
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            { arguments: { label: "API", typeId: "worker" }, name: "add_node" },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Done."));

      await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

      expect(toolMessageOfCall(run, 1)?.content).toBe("Operation applied.");
    });

    it("falls back to a bare confirmation when the returned graph gained no edge", async () => {
      const { ai, run } = fixtureAi();
      const unchanged = graphWithExistingEntities();
      applyMutation.mockResolvedValue({ graph: unchanged, rejected: false });
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: {
                edgeType: "data-flow",
                source: "node-a",
                target: "node-b",
              },
              name: "add_edge",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Done."));

      await runDiagramChatTurn(turnInput(ai, "Connect them.", unchanged));

      expect(toolMessageOfCall(run, 1)?.content).toBe("Operation applied.");
    });

    it("reports the created edge id", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: {
                edgeType: "data-flow",
                source: "node-a",
                target: "node-b",
              },
              name: "add_edge",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Connected."));

      await runDiagramChatTurn(
        turnInput(ai, "Connect them.", graphWithExistingEntities()),
      );

      expect(toolMessageOfCall(run, 1)?.content).toMatch(
        /^Operation applied\. Created edge id: .+\.$/,
      );
    });

    it("rebuilds the system prompt every round so the model always sees the current canvas", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          sseToolCallRound([
            {
              arguments: { nodeId: "node-a", label: "Renamed" },
              name: "update_node",
            },
          ]),
        )
        .mockResolvedValueOnce(sseTextRound("Renamed it."));

      await runDiagramChatTurn(
        turnInput(ai, "Rename node A.", graphWithExistingEntities()),
      );

      for (let index = 0; index < 2; index += 1) {
        const system = inputsOfCall(run, index).messages[0];
        expect(system.role).toBe("system");
        // Both the catalog digest and the current-canvas digest, on every round.
        expect(system.content).toContain("## Available node types");
        expect(system.content).toContain("## Current diagram contents");
        expect(system.content).toContain("id: node-a");
      }
    });
  });

  it("treats a tool call whose streamed arguments are empty as a zero-argument call", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseToolCallRound([{ arguments: "", name: "rename_diagram" }]),
      )
      .mockResolvedValueOnce(sseTextRound("Nothing to change."));

    await runDiagramChatTurn(turnInput(ai, "Rename it."));

    // Empty arguments text becomes `{}`, so zod reaches `rename_diagram`'s own
    // "needs a title and/or a description" refinement rather than reporting the far less useful
    // "expected object, received string" it would produce for an unparsed empty string.
    expect(toolMessageOfCall(run, 1)?.content).toContain(
      "rename_diagram requires title and/or description.",
    );
  });

  it("never relays the reasoning model's chain of thought to onToken", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream([
        deltaPayload({
          content: "",
          reasoning_content: null,
          role: "assistant",
        }),
        deltaPayload({ reasoning_content: "The user wants a Worker…" }),
        deltaPayload({ content: "Here is the plan." }),
      ]),
    );

    const result = await runDiagramChatTurn(turnInput(ai, "Explain."));

    expect(result.assistantText).toBe("Here is the plan.");
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("Here is the plan.");
  });

  it("skips a malformed (non-JSON) SSE data line and still assembles the rest of the streamed answer", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream([
        deltaPayload({ content: "Good " }),
        "{not valid json",
        deltaPayload({ content: "text." }),
      ]),
    );

    const result = await runDiagramChatTurn(
      turnInput(ai, "Explain the diagram."),
    );

    expect(result.assistantText).toBe("Good text.");
  });

  it("ignores a non-object streamed chunk payload (e.g. a bare number) without crashing", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream(["42", JSON.stringify({ response: "Real text." })]),
    );

    const result = await runDiagramChatTurn(
      turnInput(ai, "Explain the diagram."),
    );

    expect(result.assistantText).toBe("Real text.");
  });

  it("still reads the legacy Cloudflare-native { response } streamed chunk shape", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream([
        JSON.stringify({ response: "Legacy " }),
        JSON.stringify({ response: "shape." }),
      ]),
    );

    const result = await runDiagramChatTurn(turnInput(ai, "Explain."));

    expect(result.assistantText).toBe("Legacy shape.");
  });

  it("ignores a streamed tool-call fragment that never carried a name", async () => {
    const { ai, run } = fixtureAi();
    run.mockResolvedValueOnce(
      sseStream([
        deltaPayload({
          tool_calls: [
            { function: { arguments: "{}" }, index: 0, type: "function" },
          ],
        }),
        deltaPayload({ tool_calls: ["not an object"] }),
        deltaPayload({ content: "Nothing to do." }),
      ]),
    );

    const result = await runDiagramChatTurn(turnInput(ai, "Explain."));

    expect(result.toolCallCount).toBe(0);
    expect(result.assistantText).toBe("Nothing to do.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("assembles a streamed tool call whose fragments carry no index, falling back to position", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseStream([
          deltaPayload({
            tool_calls: [
              { function: { arguments: "", name: "add_node" }, id: "call_0" },
            ],
          }),
          deltaPayload({
            tool_calls: [
              { function: { arguments: '{"typeId":"worker",' }, id: null },
            ],
          }),
          deltaPayload({
            tool_calls: [
              { function: { arguments: '"label":"API"}' }, id: null },
            ],
          }),
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Added it."));

    await runDiagramChatTurn(turnInput(ai, "Add a Worker."));

    expect(applyMutation.mock.calls[0]?.[0]).toMatchObject({
      input: { label: "API", typeId: "worker" },
      kind: "add_node",
    });
  });

  it("ignores a streamed tool-call fragment carrying no function object at all", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseStream([
          deltaPayload({
            tool_calls: [
              {
                function: { arguments: "", name: "rename_diagram" },
                id: "call_0",
                index: 0,
              },
            ],
          }),
          // A fragment that advances nothing -- no `function` key whatsoever.
          deltaPayload({ tool_calls: [{ id: null, index: 0 }] }),
          deltaPayload({
            tool_calls: [
              {
                function: { arguments: '{"title":"Renamed"}' },
                id: null,
                index: 0,
              },
            ],
          }),
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Renamed."));

    await runDiagramChatTurn(turnInput(ai, "Rename it."));

    expect(renameDiagram).toHaveBeenCalledWith("Renamed", undefined);
  });

  it("ignores a streamed tool-call fragment whose arguments are not a string", async () => {
    const { ai, run } = fixtureAi();
    run
      .mockResolvedValueOnce(
        sseStream([
          deltaPayload({
            tool_calls: [
              {
                function: { arguments: null, name: "rename_diagram" },
                id: "call_0",
                index: 0,
              },
            ],
          }),
          deltaPayload({
            tool_calls: [
              {
                function: { arguments: '{"title":"Renamed"}', name: null },
                id: null,
                index: 0,
              },
            ],
          }),
        ]),
      )
      .mockResolvedValueOnce(sseTextRound("Renamed."));

    await runDiagramChatTurn(turnInput(ai, "Rename it."));

    expect(renameDiagram).toHaveBeenCalledWith("Renamed", undefined);
  });

  describe("defensive non-streaming fallback", () => {
    /** An `openai-chat`-shaped non-streaming result. */
    function openAiResult(
      content: string | null,
      toolCalls?: WireToolCall[],
    ): AiChatRunResult {
      return { choices: [{ message: { content, tool_calls: toolCalls } }] };
    }

    it("reads tool calls and text from an openai-chat-shaped object response", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          openAiResult(null, [
            {
              function: {
                arguments: '{"label":"API","typeId":"worker"}',
                name: "add_node",
              },
              id: "call_abc",
              type: "function",
            },
          ]),
        )
        .mockResolvedValueOnce(openAiResult("Already complete."));

      const result = await runDiagramChatTurn(turnInput(ai, "Add a node."));

      expect(applyMutation).toHaveBeenCalledTimes(1);
      expect(result.assistantText).toBe("Already complete.");
      expect(onToken).toHaveBeenCalledWith("Already complete.");
      expect(toolMessageOfCall(run, 1)?.tool_call_id).toBe("call_abc");
    });

    it("treats an openai-chat-shaped tool call with no arguments field as a zero-argument call", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce(
          openAiResult(null, [
            {
              function: { name: "rename_diagram" },
              id: "call_abc",
              type: "function",
            } as unknown as WireToolCall,
          ]),
        )
        .mockResolvedValueOnce(openAiResult("Nothing to change."));

      await runDiagramChatTurn(turnInput(ai, "Rename it."));

      // Missing arguments become `{}`, reaching `rename_diagram`'s own refinement rather than a
      // confusing "expected object, received undefined".
      expect(toolMessageOfCall(run, 1)?.content).toContain(
        "rename_diagram requires title and/or description.",
      );
    });

    it("reads the legacy Cloudflare-native { response, tool_calls } object shape and synthesizes tool call ids", async () => {
      const { ai, run } = fixtureAi();
      run
        .mockResolvedValueOnce({
          tool_calls: [
            {
              arguments: { label: "API", typeId: "worker" },
              name: "add_node",
            },
          ],
        } satisfies AiChatRunResult)
        .mockResolvedValueOnce({
          response: "Legacy done.",
        } satisfies AiChatRunResult);

      const result = await runDiagramChatTurn(turnInput(ai, "Add a node."));

      expect(applyMutation).toHaveBeenCalledTimes(1);
      expect(result.assistantText).toBe("Legacy done.");
      expect(toolMessageOfCall(run, 1)?.tool_call_id).toBe("call_0");
    });

    it("returns an empty final answer without calling onToken when the object response has no text", async () => {
      const { ai, run } = fixtureAi();
      run.mockResolvedValueOnce({});

      const result = await runDiagramChatTurn(turnInput(ai, "Explain."));

      expect(result.assistantText).toBe("");
      expect(onToken).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
