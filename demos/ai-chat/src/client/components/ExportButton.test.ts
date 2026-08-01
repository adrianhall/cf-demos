import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../stores/chat";
import { downloadTextFile } from "../lib/download";
import ExportButton from "./ExportButton.vue";

vi.mock("../lib/download", () => ({
  downloadTextFile: vi.fn(),
}));

/** Build a minimal `ChatTurn` fixture. */
function buildTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    modelId: "@cf/ibm-granite/granite-4.0-h-micro",
    modelDisplayName: "Granite 4.0 H Micro",
    temperature: 0.6,
    maxTokens: 256,
    userContent: "Hello",
    answer: "Hi there.",
    thinking: "",
    status: "done",
    ttftMs: 50,
    totalMs: 100,
    usage: null,
    finishReason: "stop",
    errorDetail: null,
    ...overrides,
  };
}

describe("ExportButton", () => {
  it("is disabled when the conversation has no turns", () => {
    const wrapper = mount(ExportButton, { props: { turns: [] } });

    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
  });

  it("downloads a Markdown file built from the conversation when activated", async () => {
    const wrapper = mount(ExportButton, { props: { turns: [buildTurn()] } });

    await wrapper.get("button").trigger("click");

    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, content] = vi.mocked(downloadTextFile).mock.calls[0] ?? [];
    expect(filename).toMatch(/^ai-chat-transcript-.*\.md$/u);
    expect(content).toContain("Hi there.");
  });
});
