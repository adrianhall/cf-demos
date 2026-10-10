import { type ShallowRef, onScopeDispose, shallowRef } from "vue";

/**
 * Lifecycle of the voice dictation control (docs/06-AGENTIC-CHAT.md Phase 5, US-4).
 * `"requesting-permission"` is distinct from `"recording"` so a component can show a
 * "waiting for microphone access" state instead of assuming the browser's permission prompt
 * resolves instantly.
 */
export type DictationState =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

/** Reactive surface this composable exposes; see {@link useVoiceDictation}'s own JSDoc. */
export interface UseVoiceDictationResult {
  /** Current lifecycle state of the dictation control. */
  readonly state: Readonly<ShallowRef<DictationState>>;
  /** A clear, user-facing message for the `"error"` state (denied permission, an unsupported
   * browser, or a failed transcription request); `null` otherwise. */
  readonly errorMessage: Readonly<ShallowRef<string | null>>;
  /**
   * Request microphone access and start recording. A no-op while already
   * `"requesting-permission"` or `"recording"`. Clears any previous {@link errorMessage} so a
   * denied-permission or failed-transcription state is directly recoverable by trying again.
   */
  start(): void;
  /**
   * Stop the active recording and begin transcription. A no-op unless currently `"recording"`.
   */
  stop(): void;
}

/** RFC 9457 error response shape used for safe client error messages. */
interface ProblemDetails {
  /** Human-readable explanation of the failed request. */
  detail?: string;
}

/** Read a safe error message from a failed `/api/transcribe` response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Transcription failed with status ${response.status}.`;
}

/**
 * Record a short utterance via the browser's `MediaRecorder` and post it, unmodified, to
 * `POST /api/transcribe` -- Spike E confirmed a browser's raw `MediaRecorder` output
 * (`audio/webm;codecs=opus` on Chromium, `audio/ogg;codecs=opus` on Firefox) transcribes just as
 * accurately as a client-side-converted WAV, so this composable never re-encodes anything.
 *
 * This is the **one** place this demo speaks the `MediaRecorder`/`getUserMedia` browser APIs,
 * mirroring `useChatAgent`'s own "one seam" rule for the Agent WebSocket protocol
 * (docs/06-AGENTIC-CHAT.md Section 6.2a) -- `ChatComposer.vue` only ever reads this composable's
 * reactive `state`/`errorMessage` and calls its `start()`/`stop()` methods; it never touches
 * `MediaRecorder` or `navigator.mediaDevices` directly.
 *
 * @param onTranscribed Called once, with the transcribed text, after a successful
 * transcription -- never called for a denied permission or a failed transcription request (see
 * {@link UseVoiceDictationResult.errorMessage} instead). Populating (never auto-submitting) a
 * composer with that text is the caller's responsibility (US-4's acceptance criterion); this
 * composable has no opinion about where the text goes.
 * @returns The reactive dictation state/error surface, and imperative `start()`/`stop()`
 * methods.
 */
export function useVoiceDictation(
  onTranscribed: (text: string) => void,
): UseVoiceDictationResult {
  const state = shallowRef<DictationState>("idle");
  const errorMessage = shallowRef<string | null>(null);

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let disposed = false;

  /** Stop every track of the active stream and forget the recorder/stream, if any. */
  function releaseStream(): void {
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
    recorder = null;
  }

  /** Post the recorded audio to `POST /api/transcribe` and report the result. */
  async function transcribe(
    chunks: readonly Blob[],
    mimeType: string,
  ): Promise<void> {
    if (disposed) {
      return;
    }
    state.value = "transcribing";
    try {
      // `mimeType` falls back to "audio/webm" for a defensive reason only: a spec-conforming
      // `MediaRecorder.mimeType` should never be empty, but a hostile or unusual environment is
      // not worth trusting blindly. `blob.type` is deliberately read back from the `Blob` just
      // constructed (rather than re-deriving it from `mimeType` a second time) so this fallback
      // has exactly one place it can apply.
      const blob = new Blob([...chunks], { type: mimeType || "audio/webm" });
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": blob.type },
        body: blob,
      });
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as { text: string };
      if (disposed) {
        return;
      }
      state.value = "idle";
      onTranscribed(body.text);
    } catch (cause) {
      if (disposed) {
        return;
      }
      state.value = "error";
      errorMessage.value =
        cause instanceof Error
          ? cause.message
          : "Could not transcribe the recording.";
    }
  }

  /** @see {@link UseVoiceDictationResult.start} */
  function start(): void {
    if (
      state.value === "recording" ||
      state.value === "requesting-permission"
    ) {
      return;
    }
    errorMessage.value = null;

    if (
      typeof navigator === "undefined" ||
      navigator.mediaDevices?.getUserMedia === undefined ||
      typeof MediaRecorder === "undefined"
    ) {
      state.value = "error";
      errorMessage.value = "Voice dictation is not supported in this browser.";
      return;
    }

    state.value = "requesting-permission";
    void requestAndRecord();
  }

  /** Request microphone access and, once granted, start recording. Split out of `start()` so
   * the permission prompt's own async gap can be safely abandoned by a `stop()` or
   * scope-disposal that happens while it is pending. */
  async function requestAndRecord(): Promise<void> {
    let requestedStream: MediaStream;
    try {
      requestedStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    } catch {
      if (!disposed) {
        state.value = "error";
        errorMessage.value =
          "Microphone permission was denied. Allow microphone access and try again.";
      }
      return;
    }

    if (disposed || state.value !== "requesting-permission") {
      // A `stop()` (no-op while only "requesting-permission", so this is actually unreachable
      // today) or scope disposal already moved on; release the stream this call just acquired
      // rather than leaving the microphone indicator active for nothing.
      for (const track of requestedStream.getTracks()) {
        track.stop();
      }
      return;
    }

    stream = requestedStream;
    const chunks: Blob[] = [];
    const activeRecorder = new MediaRecorder(requestedStream);
    recorder = activeRecorder;
    activeRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    activeRecorder.addEventListener("stop", () => {
      const mimeType = activeRecorder.mimeType;
      releaseStream();
      void transcribe(chunks, mimeType);
    });
    activeRecorder.start();
    state.value = "recording";
  }

  /** @see {@link UseVoiceDictationResult.stop} */
  function stop(): void {
    if (state.value !== "recording" || recorder === null) {
      return;
    }
    // The recorder's own "stop" listener (registered in `requestAndRecord()`) releases the
    // stream and starts transcription once the browser finishes flushing the final chunk.
    recorder.stop();
  }

  onScopeDispose(() => {
    disposed = true;
    if (recorder !== null && recorder.state === "recording") {
      recorder.stop();
    }
    releaseStream();
  });

  return { state, errorMessage, start, stop };
}
