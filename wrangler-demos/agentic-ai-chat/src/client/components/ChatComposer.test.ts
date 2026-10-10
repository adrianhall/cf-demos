import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer from "./ChatComposer.vue";

/** A deterministic `MediaRecorder` double (docs/06-AGENTIC-CHAT.md Phase 5, US-4) -- see
 * `useVoiceDictation.test.ts` for the full mechanism this mirrors; this file only needs enough
 * of it to prove the mic button wires up to that composable correctly, not to re-test the
 * composable's own state machine. */
class MockMediaRecorder extends EventTarget {
  static instances: MockMediaRecorder[] = [];
  static nextEmittedBlob = new Blob(["fake-audio-bytes"], {
    type: "audio/webm",
  });

  mimeType = "audio/webm;codecs=opus";

  constructor(public readonly stream: MediaStream) {
    super();
    MockMediaRecorder.instances.push(this);
  }

  start(): void {}

  stop(): void {
    const dataEvent = new Event("dataavailable") as Event & { data: Blob };
    dataEvent.data = MockMediaRecorder.nextEmittedBlob;
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

/** A no-op `MediaStream` double -- this file never asserts on track teardown itself. */
class MockMediaStream {
  getTracks(): { stop(): void }[] {
    return [{ stop(): void {} }];
  }
}

describe("ChatComposer", () => {
  it("sends a trimmed, non-empty prompt and clears the composer", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("  What is the capital of France?  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([
      ["What is the capital of France?"],
    ]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");
  });

  it("does not emit send for a blank draft", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });

    await wrapper.get("textarea").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("submits on Enter but inserts a newline on Shift+Enter", async () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("Hello");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("send")).toBeUndefined();

    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toEqual([["Hello"]]);
  });

  it("disables the textarea and Send control while streaming", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: true, disabled: false },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });

  it("disables the textarea and Send control while there is no live connection", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: true },
    });

    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });

  it("disables Send while the draft is empty", () => {
    const wrapper = mount(ChatComposer, {
      props: { isStreaming: false, disabled: false },
    });

    expect(wrapper.get(".send-button").attributes("disabled")).toBeDefined();
  });

  describe("voice dictation (US-4)", () => {
    beforeEach(() => {
      MockMediaRecorder.instances = [];
      vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: removing a jsdom-absent-by-default property after each test.
      delete (navigator as any).mediaDevices;
    });

    /** Install a `getUserMedia` double resolving to a fresh {@link MockMediaStream}. */
    function stubMicrophoneAccess(): void {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
        },
      });
    }

    it("appends a successful transcription to the composer without submitting", async () => {
      stubMicrophoneAccess();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ text: "What is the capital of France?" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );
      const wrapper = mount(ChatComposer, {
        props: { isStreaming: false, disabled: false },
      });
      const textarea = wrapper.get("textarea");
      await textarea.setValue("Question: ");

      await wrapper.get(".dictate-button").trigger("click");
      await vi.waitFor(() =>
        expect(MockMediaRecorder.instances).toHaveLength(1),
      );
      await wrapper.get(".dictate-button").trigger("click");
      MockMediaRecorder.instances[0]?.stop();
      await vi.waitFor(() =>
        expect((textarea.element as HTMLTextAreaElement).value).toBe(
          "Question: What is the capital of France?",
        ),
      );

      expect(wrapper.emitted("send")).toBeUndefined();
    });

    it("ignores a transcription that trims to empty, leaving the composer untouched", async () => {
      stubMicrophoneAccess();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ text: "   " }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const wrapper = mount(ChatComposer, {
        props: { isStreaming: false, disabled: false },
      });
      const textarea = wrapper.get("textarea");
      await textarea.setValue("Existing draft");

      await wrapper.get(".dictate-button").trigger("click");
      await vi.waitFor(() =>
        expect(MockMediaRecorder.instances).toHaveLength(1),
      );
      await wrapper.get(".dictate-button").trigger("click");
      MockMediaRecorder.instances[0]?.stop();
      await vi.waitFor(() =>
        expect(wrapper.get(".dictate-button").attributes("aria-pressed")).toBe(
          "false",
        ),
      );

      expect((textarea.element as HTMLTextAreaElement).value).toBe(
        "Existing draft",
      );
    });

    it("populates an empty composer directly with a successful transcription", async () => {
      stubMicrophoneAccess();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ text: "What is the capital of France?" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );
      const wrapper = mount(ChatComposer, {
        props: { isStreaming: false, disabled: false },
      });
      const textarea = wrapper.get("textarea");

      await wrapper.get(".dictate-button").trigger("click");
      await vi.waitFor(() =>
        expect(MockMediaRecorder.instances).toHaveLength(1),
      );
      await wrapper.get(".dictate-button").trigger("click");
      MockMediaRecorder.instances[0]?.stop();
      await vi.waitFor(() =>
        expect((textarea.element as HTMLTextAreaElement).value).toBe(
          "What is the capital of France?",
        ),
      );
    });

    it("shows a clear, recoverable error when microphone permission is denied", async () => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi
            .fn()
            .mockRejectedValue(
              new DOMException("Permission denied", "NotAllowedError"),
            ),
        },
      });
      const wrapper = mount(ChatComposer, {
        props: { isStreaming: false, disabled: false },
      });

      await wrapper.get(".dictate-button").trigger("click");
      await vi.waitFor(() =>
        expect(wrapper.find("[role=alert]").exists()).toBe(true),
      );

      expect(wrapper.get("[role=alert]").text()).toBe(
        "Microphone permission was denied. Allow microphone access and try again.",
      );
    });

    it("disables the mic button while streaming or while there is no live connection", () => {
      const streaming = mount(ChatComposer, {
        props: { isStreaming: true, disabled: false },
      });
      expect(
        streaming.get(".dictate-button").attributes("disabled"),
      ).toBeDefined();

      const disconnected = mount(ChatComposer, {
        props: { isStreaming: false, disabled: true },
      });
      expect(
        disconnected.get(".dictate-button").attributes("disabled"),
      ).toBeDefined();
    });

    it("labels the mic button for assistive technology and toggles aria-pressed while recording", async () => {
      stubMicrophoneAccess();
      const wrapper = mount(ChatComposer, {
        props: { isStreaming: false, disabled: false },
      });

      expect(wrapper.get(".dictate-button").attributes("aria-label")).toBe(
        "Start voice dictation",
      );
      expect(wrapper.get(".dictate-button").attributes("aria-pressed")).toBe(
        "false",
      );

      await wrapper.get(".dictate-button").trigger("click");
      await vi.waitFor(() =>
        expect(wrapper.get(".dictate-button").attributes("aria-pressed")).toBe(
          "true",
        ),
      );
      expect(wrapper.get(".dictate-button").attributes("aria-label")).toBe(
        "Stop recording and transcribe",
      );
    });
  });
});
