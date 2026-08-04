import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useVoiceDictation } from "./useVoiceDictation";

/** A deterministic, controllable `MediaStreamTrack` double. */
class MockMediaStreamTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

/** A deterministic `MediaStream` double carrying a fixed number of mock tracks. */
class MockMediaStream {
  readonly tracks: MockMediaStreamTrack[];

  constructor(trackCount = 1) {
    this.tracks = Array.from(
      { length: trackCount },
      () => new MockMediaStreamTrack(),
    );
  }

  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }
}

/**
 * A deterministic `MediaRecorder` double. `stop()` synchronously emits a `dataavailable` event
 * carrying {@link MockMediaRecorder.nextEmittedBlob} followed by a `stop` event -- mirroring the
 * real browser's own event order closely enough for `useVoiceDictation`'s "stop" listener
 * (registered on construction) to run exactly as it would against a real recorder.
 */
class MockMediaRecorder extends EventTarget {
  static instances: MockMediaRecorder[] = [];
  static nextEmittedBlob = new Blob(["fake-audio-bytes"], {
    type: "audio/webm",
  });

  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  readonly stream: MediaStream;

  constructor(stream: MediaStream) {
    super();
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const dataEvent = new Event("dataavailable") as Event & { data: Blob };
    dataEvent.data = MockMediaRecorder.nextEmittedBlob;
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

/** Install a controllable `getUserMedia` double, resolving or rejecting as the test directs. */
function stubGetUserMedia(
  implementation: () => Promise<MediaStream>,
): ReturnType<typeof vi.fn> {
  const getUserMedia = vi.fn(implementation);
  // jsdom's `navigator.mediaDevices` is `undefined` by default -- a plain assignment (not
  // `vi.stubGlobal`, which would replace the whole `navigator` object other libraries also
  // read) is enough to add it for the duration of one test.
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

describe("useVoiceDictation", () => {
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    MockMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: removing a jsdom-absent-by-default property for the next test.
    delete (navigator as any).mediaDevices;
  });

  it("requests microphone access and starts recording once granted", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    expect(result.state.value).toBe("requesting-permission");

    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0]?.state).toBe("recording");
  });

  it("surfaces a clear, recoverable error when microphone permission is denied", async () => {
    stubGetUserMedia(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("error"));

    expect(result.errorMessage.value).toBe(
      "Microphone permission was denied. Allow microphone access and try again.",
    );
    expect(onTranscribed).not.toHaveBeenCalled();
    expect(MockMediaRecorder.instances).toHaveLength(0);
  });

  it("reports voice dictation as unsupported when the browser has no MediaRecorder", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    stubGetUserMedia(
      async () => new MockMediaStream() as unknown as MediaStream,
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();

    expect(result.state.value).toBe("error");
    expect(result.errorMessage.value).toBe(
      "Voice dictation is not supported in this browser.",
    );
  });

  it("transcribes the recording on stop() and invokes onTranscribed, releasing the stream", async () => {
    const stream = new MockMediaStream(2);
    stubGetUserMedia(async () => stream as unknown as MediaStream);
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
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));

    result.stop();
    expect(result.state.value).toBe("transcribing");
    expect(stream.tracks.every((track) => track.stopped)).toBe(true);

    await vi.waitFor(() => expect(onTranscribed).toHaveBeenCalledTimes(1));
    expect(onTranscribed).toHaveBeenCalledWith(
      "What is the capital of France?",
    );
    expect(result.state.value).toBe("idle");

    const [, requestInit] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(requestInit?.method).toBe("POST");
  });

  it("surfaces a clear, recoverable error when the transcription request fails", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail:
              "Workers AI could not transcribe the submitted audio. Try again.",
          }),
          {
            status: 502,
            headers: { "content-type": "application/problem+json" },
          },
        ),
      ),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.stop();

    await vi.waitFor(() => expect(result.state.value).toBe("error"));
    expect(result.errorMessage.value).toBe(
      "Workers AI could not transcribe the submitted audio. Try again.",
    );
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when a failed response body is not valid JSON", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.stop();

    await vi.waitFor(() => expect(result.state.value).toBe("error"));
    expect(result.errorMessage.value).toBe(
      "Transcription failed with status 500.",
    );
  });

  it("discards a successful transcription that resolves after the effect scope is disposed", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.stop();
    expect(result.state.value).toBe("transcribing");

    scope.stop();
    resolveFetch?.(
      new Response(JSON.stringify({ text: "too late" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it("discards a failed transcription that resolves after the effect scope is disposed", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.stop();
    expect(result.state.value).toBe("transcribing");

    scope.stop();
    resolveFetch?.(new Response(null, { status: 502 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Disposal must freeze the state exactly as it was, not flip it to "error" for a chat the
    // component has already torn down.
    expect(result.state.value).toBe("transcribing");
    expect(result.errorMessage.value).toBeNull();
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it("falls back to a generic error message when the fetch call itself rejects with a non-Error value", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network down"));
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.stop();

    await vi.waitFor(() => expect(result.state.value).toBe("error"));
    expect(result.errorMessage.value).toBe(
      "Could not transcribe the recording.",
    );
  });

  it("does not surface a permission-denied error after the effect scope has already been disposed", async () => {
    let rejectGetUserMedia: ((reason: unknown) => void) | undefined;
    stubGetUserMedia(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectGetUserMedia = reject;
        }),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    expect(result.state.value).toBe("requesting-permission");

    scope.stop();
    rejectGetUserMedia?.(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(result.errorMessage.value).toBeNull();
  });

  it("defaults to audio/webm when the recorder reports an empty mimeType", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    const recorder = MockMediaRecorder.instances[0];
    if (!recorder) throw new Error("Expected a MediaRecorder instance.");
    recorder.mimeType = "";

    result.stop();
    await vi.waitFor(() => expect(onTranscribed).toHaveBeenCalled());

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const headers = requestInit?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("audio/webm");
  });

  it("ignores a zero-byte dataavailable event without recording a phantom empty chunk", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    const recorder = MockMediaRecorder.instances[0];
    if (!recorder) throw new Error("Expected a MediaRecorder instance.");

    // Some environments can emit a zero-byte `dataavailable` event mid-recording; it must be
    // ignored, not accumulated as a phantom empty audio chunk.
    const emptyEvent = new Event("dataavailable") as Event & { data: Blob };
    emptyEvent.data = new Blob([], { type: "audio/webm" });
    recorder.dispatchEvent(emptyEvent);

    result.stop();

    await vi.waitFor(() => expect(onTranscribed).toHaveBeenCalledWith("ok"));
  });

  it("clears a previous error the moment start() is called again", async () => {
    stubGetUserMedia(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("error"));
    expect(result.errorMessage.value).not.toBeNull();

    result.start();
    expect(result.errorMessage.value).toBeNull();
  });

  it("is a no-op to start recording while already recording or requesting permission", async () => {
    const stream = new MockMediaStream();
    const getUserMedia = stubGetUserMedia(
      async () => stream as unknown as MediaStream,
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));
    result.start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances).toHaveLength(1);
  });

  it("is a no-op to stop when not recording", () => {
    const onTranscribed = vi.fn();
    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.stop();

    expect(result.state.value).toBe("idle");
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it("stops an active recording and releases the stream when the owning effect scope is disposed", async () => {
    const stream = new MockMediaStream();
    stubGetUserMedia(async () => stream as unknown as MediaStream);
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    await vi.waitFor(() => expect(result.state.value).toBe("recording"));

    scope.stop();

    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
  });

  it("releases a stream granted after disposal instead of leaving the microphone active", async () => {
    const stream = new MockMediaStream();
    let resolveGetUserMedia: ((value: MediaStream) => void) | undefined;
    stubGetUserMedia(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    const onTranscribed = vi.fn();

    const result = scope.run(() => useVoiceDictation(onTranscribed));
    if (!result) throw new Error("effectScope did not run");

    result.start();
    expect(result.state.value).toBe("requesting-permission");

    scope.stop();
    resolveGetUserMedia?.(stream as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
    expect(MockMediaRecorder.instances).toHaveLength(0);
  });
});
