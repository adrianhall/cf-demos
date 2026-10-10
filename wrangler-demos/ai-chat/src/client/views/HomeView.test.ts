import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamFrame } from "../../chat-protocol";
import { useChatStore } from "../stores/chat";
import { useSettingsStore } from "../stores/settings";
import HomeView from "./HomeView.vue";

/** Build a successful `text/event-stream` response carrying the given frames. */
function streamResponse(frames: readonly ChatStreamFrame[]): Response {
  const body = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("HomeView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the model selector, transcript, composer, and export control", () => {
    const wrapper = mount(HomeView);

    expect(wrapper.find("fieldset").exists()).toBe(true);
    expect(wrapper.find("textarea").exists()).toBe(true);
    expect(wrapper.find(".export-button").exists()).toBe(true);
    expect(wrapper.text()).toContain("No messages yet");
  });

  it("selecting a different model updates the settings store", async () => {
    const wrapper = mount(HomeView);
    const settings = useSettingsStore();

    await wrapper
      .get("select")
      .setValue("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");

    expect(settings.modelId).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
  });

  it("submitting the composer sends the prompt to the chat store and renders the streamed reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamResponse([
            { type: "start", model: "m", requestId: "r" },
            { type: "answer", text: "Paris." },
            {
              type: "done",
              finishReason: "stop",
              ttftMs: 30,
              totalMs: 90,
              usage: null,
            },
          ]),
        ),
      ),
    );

    const wrapper = mount(HomeView);

    await wrapper.get("textarea").setValue("What is the capital of France?");
    await wrapper.get("form").trigger("submit");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Paris."));

    expect(wrapper.text()).toContain("What is the capital of France?");
  });

  it("shows a session-expired notice with a reload control after a lapsed Access session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: "Unauthorized." }), {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          }),
        ),
      ),
    );

    const wrapper = mount(HomeView);
    const chat = useChatStore();
    await chat.submit("Hello");
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[role="alert"].session-expired').text()).toContain(
      "session expired",
    );
    const reloadButton = wrapper.get(".session-expired button");
    expect(reloadButton.text()).toBe("Reload");

    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await reloadButton.trigger("click");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
