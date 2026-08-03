import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { ChatTurn } from "../composables/useChatAgent";
import ChatTranscript from "./ChatTranscript.vue";

/** Build a complete `ChatTurn` fixture, overriding only the fields a test cares about. */
function buildTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    role: "assistant",
    content: "",
    status: "streaming",
    errorDetail: null,
    ...overrides,
  };
}

describe("ChatTranscript", () => {
  it("shows an empty-state message when there are no turns", () => {
    const wrapper = mount(ChatTranscript, { props: { turns: [] } });

    expect(wrapper.text()).toContain("No messages yet");
  });

  it("renders the user message and the streamed assistant content", () => {
    const wrapper = mount(ChatTranscript, {
      props: {
        turns: [
          buildTurn({
            id: "u1",
            role: "user",
            content: "What is the capital of France?",
            status: "done",
          }),
          buildTurn({
            id: "a1",
            role: "assistant",
            content: "Paris.",
            status: "done",
          }),
        ],
      },
    });

    expect(wrapper.get(".user-bubble").text()).toContain(
      "What is the capital of France?",
    );
    expect(wrapper.get(".assistant-bubble").text()).toContain("Paris.");
  });

  it("shows the activity indicator only before the first token arrives", () => {
    const streamingBeforeToken = mount(ChatTranscript, {
      props: { turns: [buildTurn({ status: "streaming", content: "" })] },
    });
    expect(streamingBeforeToken.get('[role="status"]').text()).toContain(
      "Waiting for the agent",
    );

    const streamingWithToken = mount(ChatTranscript, {
      props: {
        turns: [buildTurn({ status: "streaming", content: "The capital" })],
      },
    });
    expect(
      streamingWithToken
        .findAll('[role="status"]')
        .some((el) => el.text().includes("Waiting for the agent")),
    ).toBe(false);
  });

  it("shows the error detail for a failed turn", () => {
    const wrapper = mount(ChatTranscript, {
      props: {
        turns: [
          buildTurn({
            status: "error",
            errorDetail: "model temporarily unavailable",
          }),
        ],
      },
    });

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "model temporarily unavailable",
    );
  });

  it("falls back to a generic error message when no detail was reported", () => {
    const wrapper = mount(ChatTranscript, {
      props: { turns: [buildTurn({ status: "error", errorDetail: null })] },
    });

    expect(wrapper.get('[role="alert"]').text()).toContain(
      "could not complete this turn",
    );
  });

  it("scrolls the transcript to its bottom edge when a new turn arrives", async () => {
    const wrapper = mount(ChatTranscript, { props: { turns: [] } });
    const region = wrapper.get(".chat-transcript").element;
    Object.defineProperty(region, "scrollHeight", {
      value: 640,
      configurable: true,
    });

    await wrapper.setProps({ turns: [buildTurn()] });
    await nextTick();

    expect(region.scrollTop).toBe(640);
  });

  it("does not throw when the component is unmounted before the scroll watcher resumes", async () => {
    const wrapper = mount(ChatTranscript, { props: { turns: [] } });

    const propsUpdated = wrapper.setProps({ turns: [buildTurn()] });
    wrapper.unmount();

    await expect(propsUpdated).resolves.not.toThrow();
  });
});
