import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../stores/chat";
import ChatTranscript from "./ChatTranscript.vue";

/** Build a complete `ChatTurn` fixture, overriding only the fields a test cares about. */
function buildTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    modelId: "@cf/ibm-granite/granite-4.0-h-micro",
    modelDisplayName: "Granite 4.0 H Micro",
    temperature: 0.6,
    maxTokens: 256,
    userContent: "What is the capital of France?",
    answer: "",
    thinking: "",
    status: "streaming",
    ttftMs: null,
    totalMs: null,
    usage: null,
    finishReason: null,
    errorDetail: null,
    ...overrides,
  };
}

describe("ChatTranscript", () => {
  it("shows an empty-state message when there are no turns", () => {
    const wrapper = mount(ChatTranscript, { props: { turns: [] } });

    expect(wrapper.text()).toContain("No messages yet");
  });

  it("renders the user message and the streamed answer", () => {
    const wrapper = mount(ChatTranscript, {
      props: { turns: [buildTurn({ answer: "Paris.", status: "done" })] },
    });

    expect(wrapper.get(".user-bubble").text()).toContain(
      "What is the capital of France?",
    );
    expect(wrapper.get(".assistant-bubble").text()).toContain("Paris.");
  });

  it("shows the activity indicator only before the first token arrives", () => {
    const streamingBeforeToken = mount(ChatTranscript, {
      props: { turns: [buildTurn({ status: "streaming" })] },
    });
    expect(streamingBeforeToken.get('[role="status"]').text()).toContain(
      "Waiting for the model",
    );

    const streamingWithToken = mount(ChatTranscript, {
      props: {
        turns: [buildTurn({ status: "streaming", answer: "The capital" })],
      },
    });
    expect(
      streamingWithToken
        .findAll('[role="status"]')
        .some((el) => el.text().includes("Waiting for the model")),
    ).toBe(false);
  });

  it("renders a Thinking panel only when the turn produced reasoning text", () => {
    const withReasoning = mount(ChatTranscript, {
      props: {
        turns: [
          buildTurn({
            status: "done",
            thinking: "Step one.",
            answer: "Paris.",
          }),
        ],
      },
    });
    expect(withReasoning.find("details").exists()).toBe(true);

    const withoutReasoning = mount(ChatTranscript, {
      props: { turns: [buildTurn({ status: "done", answer: "Paris." })] },
    });
    expect(withoutReasoning.find("details").exists()).toBe(false);
  });

  it("shows the error detail for a failed turn", () => {
    const wrapper = mount(ChatTranscript, {
      props: {
        turns: [
          buildTurn({
            status: "error",
            errorDetail: "Workers AI inference failed.",
          }),
        ],
      },
    });

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "Workers AI inference failed.",
    );
  });

  it("shows a stopped notice for a cancelled turn", () => {
    const wrapper = mount(ChatTranscript, {
      props: {
        turns: [buildTurn({ status: "stopped", finishReason: "cancelled" })],
      },
    });

    expect(wrapper.text()).toContain("Generation stopped.");
  });

  it("renders latency and token usage once a turn is no longer streaming", () => {
    const wrapper = mount(ChatTranscript, {
      props: {
        turns: [
          buildTurn({
            status: "done",
            answer: "Paris.",
            ttftMs: 120,
            totalMs: 980,
            usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
          }),
        ],
      },
    });

    const stats = wrapper.get(".turn-stats");
    expect(stats.text()).toContain("120");
    expect(stats.text()).toContain("980");
    expect(stats.text()).toContain("12 prompt / 8 completion");
  });

  it("does not throw when the component is unmounted before the scroll watcher resumes", async () => {
    const wrapper = mount(ChatTranscript, { props: { turns: [] } });

    const propsUpdated = wrapper.setProps({ turns: [buildTurn()] });
    wrapper.unmount();

    await expect(propsUpdated).resolves.not.toThrow();
  });

  it("does not render latency stats while a turn is still streaming", () => {
    const wrapper = mount(ChatTranscript, {
      props: { turns: [buildTurn({ status: "streaming", answer: "partial" })] },
    });

    expect(wrapper.find(".turn-stats").exists()).toBe(false);
  });
});
